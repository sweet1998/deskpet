import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import sys
from time import perf_counter
from typing import Any, Dict, List, Optional

from app.agent.model_client import OpenAICompatibleModel
from app.agent.route_confidence import apply_route_confidence_policy
from app.agent.service import AgentService
from app.config import settings
from app.models import ResearchPrepareRequest

from .dataset import RouteEvalCase, load_route_cases
from .scoring import score_route_results


DEFAULT_DATASET = Path(__file__).parent / "datasets" / "routing_gold.json"
DEFAULT_REPORTS = Path(__file__).parent / "reports"


async def _evaluate_case(
    service: AgentService,
    case: RouteEvalCase,
    semaphore: asyncio.Semaphore,
    retries: int,
) -> Dict[str, Any]:
    error: Optional[str] = None
    predicted = None
    raw_predicted = None
    latency_ms = None
    async with semaphore:
        started = perf_counter()
        for attempt in range(retries + 1):
            try:
                routed = await service._with_model_route(ResearchPrepareRequest(
                    roleId="stock_expert",
                    text=case.text,
                    history=case.history,
                ), apply_confidence=False)
                raw_predicted = routed.routeHint
                predicted = apply_route_confidence_policy(raw_predicted) if raw_predicted else None
                error = None
                break
            except Exception as exc:
                error = f"{type(exc).__name__}: {str(exc)[:240]}"
                if attempt < retries:
                    await asyncio.sleep(.5 * (attempt + 1))
        latency_ms = round((perf_counter() - started) * 1000, 2)
    return {
        "id": case.id,
        "split": case.split,
        "text": case.text,
        "history": [item.model_dump() for item in case.history],
        "tags": case.tags,
        "expected": case.expected.model_dump(exclude_none=True),
        "rawPredicted": raw_predicted.model_dump(exclude_none=True) if raw_predicted else None,
        "predicted": predicted.model_dump(exclude_none=True) if predicted else None,
        "latencyMs": latency_ms,
        "error": error,
    }


async def run(args: argparse.Namespace) -> Dict[str, Any]:
    cases = load_route_cases(args.dataset)
    splits = {item.strip() for item in args.split.split(",") if item.strip()}
    if splits and "all" not in splits:
        cases = [case for case in cases if case.split in splits]
    if args.limit:
        cases = cases[:args.limit]
    if args.validate_only:
        return {
            "datasetVersion": 1,
            "caseCount": len(cases),
            "splits": sorted({case.split for case in cases}),
        }
    model = OpenAICompatibleModel(
        settings.router_model_base_url,
        settings.router_model_api_key,
        settings.router_model_name,
        max(args.timeout, settings.router_model_timeout),
    )
    if not model.configured:
        raise RuntimeError("ROUTER_MODEL_API_KEY 或 ROUTER_MODEL_NAME 未配置")
    service = AgentService(None, model, model)  # type: ignore[arg-type]
    semaphore = asyncio.Semaphore(max(1, args.concurrency))
    try:
        tasks = [
            asyncio.create_task(_evaluate_case(service, case, semaphore, args.retries))
            for case in cases
        ]
        results = []
        for completed, task in enumerate(asyncio.as_completed(tasks), start=1):
            results.append(await task)
            if completed % 10 == 0 or completed == len(tasks):
                print(f"已评测 {completed}/{len(tasks)}", file=sys.stderr)
    finally:
        await model.close()
    results.sort(key=lambda item: item["id"])
    metrics = score_route_results(results)
    return {
        "schemaVersion": 1,
        "generatedAt": datetime.now().astimezone().isoformat(),
        "promptContractVersion": 8,
        "model": settings.router_model_name,
        "dataset": str(args.dataset),
        "splits": sorted({case.split for case in cases}),
        "metrics": metrics,
        "results": results,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="运行股票 Agent 语义路由评测")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--split", default="test", help="逗号分隔：development,calibration,test,all")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=30)
    parser.add_argument("--retries", type=int, default=0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = asyncio.run(run(args))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    summary = report.get("metrics") or report
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
