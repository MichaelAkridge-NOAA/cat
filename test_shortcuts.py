"""
Test script for verifying shortcut functionality
Run this after installation to test shortcut creation
"""
from cat.shortcuts import create_shortcuts, remove_shortcuts
import sys

def test_shortcuts():
    print("\n" + "="*60)
    print("CAT Shortcut Functionality Test")
    print("="*60)
    
    # Test 1: Check if pyshortcuts is available
    print("\n1️⃣ Checking pyshortcuts availability...")
    try:
        import pyshortcuts
        print("   ✅ pyshortcuts is installed")
        print(f"   Version: {pyshortcuts.__version__}")
    except ImportError:
        print("   ❌ pyshortcuts NOT installed")
        print("\n   To install: pip install pyshortcuts")
        print("   Or: pip install coral-annotation-tool[shortcuts]")
        return False
    
    # Test 2: Test shortcut creation
    print("\n2️⃣ Testing shortcut creation...")
    try:
        result = create_shortcuts()
        if result:
            print("   ✅ Shortcut creation successful")
        else:
            print("   ⚠️  Shortcut creation completed with warnings")
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False
    
    # Test 3: Verify shortcuts exist
    print("\n3️⃣ Verifying shortcuts...")
    from pathlib import Path
    
    desktop = Path.home() / "Desktop"
    if sys.platform == "win32":
        shortcut = desktop / "CAT - Coral Annotation Tool.lnk"
    elif sys.platform == "darwin":
        shortcut = desktop / "CAT - Coral Annotation Tool.app"
    else:
        shortcut = desktop / "CAT - Coral Annotation Tool.desktop"
    
    if shortcut.exists():
        print(f"   ✅ Desktop shortcut found: {shortcut}")
    else:
        print(f"   ⚠️  Desktop shortcut not found at: {shortcut}")
    
    # Test 4: Optional cleanup
    print("\n4️⃣ Cleanup test...")
    response = input("\n   Would you like to remove the test shortcuts? (y/N): ")
    if response.lower() == 'y':
        remove_shortcuts()
    else:
        print("   ℹ️  Shortcuts kept. Use 'cat-remove-shortcuts' to remove later.")
    
    print("\n" + "="*60)
    print("✅ Test completed!")
    print("="*60)
    print("\nNext steps:")
    print("  - Run 'cat-create-shortcuts' to create shortcuts")
    print("  - Run 'cat' to start the server")
    print("  - Click the desktop icon to launch CAT")
    print()
    
    return True


if __name__ == "__main__":
    test_shortcuts()
