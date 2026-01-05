#!/bin/bash
# Startup script for CAT: Coral Annotation Tool

echo "================================================"
echo "  🪸 CAT: Coral Annotation Tool"
echo "  File-based Orthomosaic Annotation"
echo "================================================"
echo ""

# Navigate to project root (one level up from scripts)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Check if config.yaml exists
if [ ! -f "config.yaml" ]; then
    echo "⚠️  Warning: config.yaml not found. Using default configuration."
    echo ""
fi

# Check if data directory exists
if [ ! -d "data" ]; then
    echo "📁 Creating data directory..."
    mkdir -p data
fi

# Check if data/reference directory exists
if [ ! -d "data/reference" ]; then
    echo "📁 Creating data/reference directory..."
    mkdir -p data/reference
fi

# Load config or use defaults
if [ -f "config.yaml" ]; then
    PORT=$(grep -A 3 "app:" config.yaml | grep "port:" | awk '{print $2}' | head -1)
    HOST=$(grep -A 3 "app:" config.yaml | grep "host:" | awk '{print $2}' | tr -d '"' | head -1)
else
    PORT=8000
    HOST="127.0.0.1"
fi

# Default to 8000 and 127.0.0.1 if not found
PORT=${PORT:-8000}
HOST=${HOST:-127.0.0.1}

echo "📋 Configuration:"
echo "   Host: $HOST"
echo "   Port: $PORT"
echo "   Project Root: $(pwd)"
echo "   Data Directory: $(pwd)/data"
echo "   Reference Data: $(pwd)/data/reference"
echo ""

# Start server
echo "🚀 Starting CAT server..."
echo ""
echo "   🌐 Web Interface: http://localhost:$PORT"
echo "   📚 API Documentation: http://localhost:$PORT/docs"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

python -m uvicorn cat.server:app --host "$HOST" --port "$PORT" --reload
