FROM ollama/ollama:latest

COPY Entrypoint.sh /app/Entrypoint.sh
# Strip Windows line endings in case the file was saved on Windows
RUN sed -i 's/\r$//' /app/Entrypoint.sh && chmod +x /app/Entrypoint.sh

EXPOSE 11434

ENTRYPOINT ["/app/Entrypoint.sh"]
