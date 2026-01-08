"""
Command-line interface for CAT: Coral Annotation Tool
"""
import sys
import argparse
from pathlib import Path
import uvicorn
import webbrowser
import threading
import time


def open_browser(url, delay=1.5):
    """Open browser after a delay to ensure server is ready"""
    def _open():
        time.sleep(delay)
        print(f"\n🌐 Opening browser: {url}")
        webbrowser.open(url)
    
    thread = threading.Thread(target=_open, daemon=True)
    thread.start()


def main():
    """Start the CAT server"""
    parser = argparse.ArgumentParser(
        description="CAT: Coral Annotation Tool - Start the web server"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to bind to (default: 8000)"
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable auto-reload for development"
    )
    parser.add_argument(
        "--data-dir",
        default="data",
        help="Data directory path (default: data)"
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't automatically open browser"
    )
    
    args = parser.parse_args()
    
    # Ensure data directory exists
    data_path = Path(args.data_dir)
    data_path.mkdir(parents=True, exist_ok=True)
    (data_path / "reference").mkdir(parents=True, exist_ok=True)
    
    print("=" * 50)
    print("  🪸 CAT: Coral Annotation Tool")
    print("  File-based Orthomosaic Annotation")
    print("=" * 50)
    print()
    print(f"📋 Configuration:")
    print(f"   Host: {args.host}")
    print(f"   Port: {args.port}")
    print(f"   Data Directory: {data_path.absolute()}")
    print()
    print(f"🌐 Web Interface: http://localhost:{args.port}")
    print(f"📚 API Documentation: http://localhost:{args.port}/docs")
    print()
    print("💡 Tip: Create desktop shortcuts with: cat-create-shortcuts")
    print()
    print("Press Ctrl+C to stop the server")
    print()
    
    # Open browser automatically unless disabled
    if not args.no_browser:
        url = f"http://localhost:{args.port}"
        open_browser(url, delay=1.5)
    
    # Start server
    uvicorn.run(
        "cat.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload
    )


def convert_cog():
    """Convert a single TIF file to COG format"""
    parser = argparse.ArgumentParser(
        description="Convert a GeoTIFF file to Cloud Optimized GeoTIFF (COG)"
    )
    parser.add_argument("input", help="Input TIF file path")
    parser.add_argument("output", help="Output COG file path")
    parser.add_argument(
        "--compression",
        choices=["lzw", "deflate", "jpeg"],
        default="lzw",
        help="Compression algorithm (default: lzw)"
    )
    
    args = parser.parse_args()
    
    # Import here to avoid loading heavy dependencies if not needed
    from cat.scripts.make_cog import convert_to_cog
    
    print(f"Converting {args.input} to COG format...")
    success = convert_to_cog(args.input, args.output, compression=args.compression)
    
    if success:
        print(f"✅ Successfully created: {args.output}")
        sys.exit(0)
    else:
        print(f"❌ Conversion failed")
        sys.exit(1)


def batch_convert():
    """Batch convert TIF files to COG format"""
    parser = argparse.ArgumentParser(
        description="Batch convert GeoTIFF files to Cloud Optimized GeoTIFF (COG)"
    )
    parser.add_argument("input_dir", help="Input directory containing TIF files")
    parser.add_argument("output_dir", help="Output directory for COG files")
    parser.add_argument(
        "--compression",
        choices=["lzw", "deflate", "jpeg"],
        default="lzw",
        help="Compression algorithm (default: lzw)"
    )
    
    args = parser.parse_args()
    
    # Import here to avoid loading heavy dependencies if not needed
    from cat.scripts.make_cog_batch import batch_convert_to_cog
    
    print(f"Batch converting files from {args.input_dir}...")
    success = batch_convert_to_cog(
        args.input_dir,
        args.output_dir,
        compression=args.compression
    )
    
    if success:
        print(f"✅ Batch conversion complete")
        sys.exit(0)
    else:
        print(f"❌ Batch conversion failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
