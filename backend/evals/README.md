# 股票 Agent 评测

`routing_gold.json` 包含 200 条固定黄金样本，拆分为 development（123）、calibration（40）和 test（37）。

仅校验数据集：

```bash
cd backend
.venv/bin/python -m evals.routing_eval --split all --validate-only
```

运行真实路由模型评测：

```bash
cd backend
.venv/bin/python -m evals.routing_eval \
  --split calibration,test \
  --concurrency 4 \
  --output evals/reports/qwen3.7-max-v8.json
```

报告包含逐条预测、路由字段准确率、Scope Macro-F1、澄清召回率、误拒率、误执行率、目标与数据需求 F1、P95 延迟、置信度分桶、ECE 和 Isotonic 校准结果。

单元测试使用模拟模型并进入常规 CI；真实模型评测消耗外部 API，仅手动或定时运行。调整 Prompt、模型或阈值时，必须保留同一测试集并对比基线报告。
