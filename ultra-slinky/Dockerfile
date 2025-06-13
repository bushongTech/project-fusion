FROM acrxbow.azurecr.us/adc_base:latest

WORKDIR /app

# Copy backend code and install Python dependencies
COPY backend/ ./backend/
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip3 install --no-cache-dir -r backend/requirements.txt

# Copy frontend files
COPY frontend/ ./frontend/

# Copy automation storage
COPY automations.json .

# Expose FastAPI port
EXPOSE 8500

# Start FastAPI
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8500"]