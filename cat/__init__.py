"""
CAT: Coral Annotation Tool
File-based Structure from Motion (SfM) orthomosaic annotation and visualization
"""

__version__ = "1.0.0"
__author__ = "Michael Akridge"
__description__ = "CAT: Coral Annotation Tool for SfM orthomosaic imagery coral reef annotation and visualization."

from cat.server import app

__all__ = ["app", "__version__"]
