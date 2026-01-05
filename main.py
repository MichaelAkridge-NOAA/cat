"""
Backward compatibility entry point for CAT: Coral Annotation Tool

For installed package, use 'cat' command instead.
For development, run this file directly: python main.py
"""

from cat.cli import main

if __name__ == "__main__":
    main()
