#!/bin/bash
# CAT Shortcut Creator for macOS/Linux
# Run this script to create desktop shortcuts

echo ""
echo "============================================================"
echo "  CAT: Coral Annotation Tool - Shortcut Creator"
echo "============================================================"
echo ""

echo "Checking if pyshortcuts is installed..."
python3 -c "import pyshortcuts" 2>/dev/null
if [ $? -ne 0 ]; then
    echo ""
    echo "[!] pyshortcuts not found. Installing..."
    pip3 install pyshortcuts
    if [ $? -ne 0 ]; then
        echo ""
        echo "[X] Failed to install pyshortcuts"
        echo ""
        echo "Please run manually:"
        echo "   pip3 install pyshortcuts"
        echo ""
        exit 1
    fi
fi

echo ""
echo "Creating shortcuts..."
python3 -m cat.shortcuts

echo ""
echo "============================================================"
echo "  Done!"
echo "============================================================"
echo ""
echo "You should now have a CAT shortcut on your desktop and in"
echo "the Applications folder."
echo ""
