from pathlib import Path


def test_frozen_entry_enables_multiprocessing_before_starting_app() -> None:
    source = (Path(__file__).parents[1] / "desktop_entry.py").read_text(encoding="utf-8")

    freeze_support = source.index("multiprocessing.freeze_support()")
    main_call = source.index("main()", freeze_support)
    app_import = source.index("from app.main import app")

    assert freeze_support < main_call
    assert "from app.main import app" not in source[: source.index("def main()")]
    assert app_import < source.index("uvicorn.run(")
