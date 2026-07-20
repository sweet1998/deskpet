import os

import uvicorn

from app.main import app


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.getenv("DESKPET_BACKEND_PORT", "18540")),
        log_level=os.getenv("DESKPET_LOG_LEVEL", "warning"),
    )
