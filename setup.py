"""
Setup configuration for CAT: Coral Annotation Tool
"""
from setuptools import setup, find_packages
from pathlib import Path

# Read the README file
this_directory = Path(__file__).parent
long_description = (this_directory / "README.md").read_text(encoding='utf-8')

# Read requirements
requirements = []
with open('requirements.txt', 'r', encoding='utf-8') as f:
    requirements = [line.strip() for line in f if line.strip() and not line.startswith('#')]

setup(
    name="coral-annotation-tool",
    version="1.0.17",
    author="NOAA",
    author_email="",
    description="File-based Structure from Motion (SfM) orthomosaic annotation tool for coral reef research",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/MichaelAkridge-NOAA/cat",  # Update with actual repo URL
    packages=find_packages(),
    classifiers=[
        "Development Status :: 4 - Beta",
        "Intended Audience :: Science/Research",
        "Topic :: Scientific/Engineering :: GIS",
        "Topic :: Scientific/Engineering :: Visualization",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.9",
    install_requires=requirements,
    entry_points={
        "console_scripts": [
            "cat=cat.cli:main",
            "cat-server=cat.cli:main",
            "cat-convert=cat.cli:convert_cog",
            "cat-batch-convert=cat.cli:batch_convert",
        ],
    },
    include_package_data=True,
    package_data={
        "": [
            "web/*.html",
            "web/*.css",
            "web/*.js",
            "docs/*.png",
            "data/reference/*.csv",
            "scripts/*.py",
            "scripts/*.sh",
            "scripts/*.bat",
        ],
    },
    zip_safe=False,
    keywords="coral annotation geotiff cog orthomosaic marine-biology gis",
)
