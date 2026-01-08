"""
CAT: Coral Annotation Tool
File-based Structure from Motion (SfM) orthomosaic annotation and visualization
"""

__version__ = "1.0.0"
__author__ = "Michael Akridge"
__description__ = "CAT: Coral Annotation Tool for SfM orthomosaic imagery coral reef annotation and visualization."

# Lazy import to avoid triggering server initialization on package import
def _get_app():
    from cat.server import app
    return app

# For backwards compatibility
def __getattr__(name):
    if name == "app":
        return _get_app()
    raise AttributeError(f"module '{__name__}' has no attribute '{name}'")

__all__ = ["__version__"]
