FROM python:3.12-slim

WORKDIR /app
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app ./app
COPY deskpet-app/src/shared/role-profiles.json ./deskpet-app/src/shared/role-profiles.json

EXPOSE 18540
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18540"]
