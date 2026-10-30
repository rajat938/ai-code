#!/bin/bash
set -e

MODEL="${MODEL:-llama3.2}"
rm -f /tmp/ollama-ready

echo "==> Starting Ollama"
ollama serve &
SERVE_PID=$!

echo "==> Waiting for Ollama..."
until ollama list > /dev/null 2>&1; do
  sleep 1
done

# Only download if the model is not already in the volume
if ollama list | awk 'NR>1 {print $1}' | grep -q "^${MODEL}\(:latest\)\?$"; then
  echo "==> Model $MODEL already present"
else
  echo "==> Downloading model: $MODEL (first run only, may take several minutes)"
  ollama pull "$MODEL"
fi

# Small embedding model used to search company policy documents
EMBED_MODEL="${EMBED_MODEL:-}"
if [ -n "$EMBED_MODEL" ]; then
  if ollama list | awk 'NR>1 {print $1}' | grep -q "^${EMBED_MODEL}\(:latest\)\?$"; then
    echo "==> Embedding model $EMBED_MODEL already present"
  else
    echo "==> Downloading embedding model: $EMBED_MODEL (~45 MB)"
    ollama pull "$EMBED_MODEL" || echo "!! Could not download $EMBED_MODEL; policy search will use keywords only"
  fi
fi

touch /tmp/ollama-ready
echo "==> Ollama is ready"

wait $SERVE_PID
