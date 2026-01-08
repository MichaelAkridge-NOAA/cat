# CAT: Coral Annotation Tool
<a href="https://github.com/MichaelAkridge-NOAA/cat" target="_blank"><img src="https://github.com/MichaelAkridge-NOAA/cat/raw/main/docs/logo.png" align="right" alt="logo" width="400"/></a>
  **C**oral **A**nnotation **T**ool - File-based , Structure from Motion (SfM) Orthomosaic coral reef annotation and visualization tool to support coral reef research.

> ⚠️ **Note: Under Active Development**: CAT is under active development. Features are being added regularly and some functionality may change. See the [Roadmap](#roadmap) section for planned improvements.

### About

**CAT** is a lightweight, file-based annotation system designed specifically for marine scientists and coral reef researchers working with Structure from Motion (SfM) orthomosaic imagery. Built with modern web technologies and Cloud Optimized GeoTIFF (COG) support, CAT provides a streamlined workflow for annotating, analyzing, and managing coral reef datasets without the complexity of databases or heavy dependencies.

Perfect for field research environments where simplicity, speed, and reliability are essential.

### Features

### **Mapping & Visualization**
- **Fast Streaming** - Dynamic tile generation for instant viewing (ala google maps but for orthomoasics)
- **High Zoom Levels** - Zoom up to 2000x for pixel-level inspection
- **Multi-Layer Support** - Work with multiple orthomosaics simultaneously
- **Shapefile Overlay** - Import and visualize existing shapefile layers

### **Annotation Tools**
- **Vector Annotations** - Draw polygons, lines, and points with custom attributes
- **Species Database** - Built-in coral species reference (1000+ species)
- **Rich Metadata** - Capture depth, health, morphology, and custom attributes
- **Real-time Editing** - Modify annotations on-the-fly with visual feedback
- **Annotation Timer** - Track time spent on each annotation session

### **Project Management**
- **File-Based Storage** - No database required, pure JSON format
- **Drag & Drop Interface** - Easy project creation with multiple TIF files
- **Auto-Discovery** - Automatically detects COG files in data directory
- **GeoJSON Export** - Export annotations in standard GeoJSON format
- **Project Templates** - Reusable project structures for consistent workflows

### **Cloud Optomized GeoTiff (COG) Processing** (https://github.com/MichaelAkridge-NOAA/sfm-orthomosaic-tile-viewer)
- **Batch Conversion** - Convert multiple GeoTIFFs to COG format simultaneously
- **One-Time Setup** - Automatic COG creation on first project load
- **Compression Options** - LZW, DEFLATE, or JPEG compression
- **Validation** - Built-in COG format validation

## Interface
<img src="./docs/example_0.png"/>
<img src="./docs/example_01.png"/>
<img src="./docs/example_02.png"/>

## Quick Start

### Prerequisites
- Python 3.9 or higher
- Local Installation. * Networked, database and cloud version in the works. 

### Installation

**Option 1: Install from PyPI (Recommended)**
- Link: https://pypi.org/project/coral-annotation-tool

```bash
pip install coral-annotation-tool
```

**Option 2: Install from source (Local Development)**

```bash
git clone https://github.com/MichaelAkridge-NOAA/cat
cd cat
pip install -e .
```

### Running the Application

After installation, simply run:

```bash
cat
```

The application will be available at: **http://localhost:8000**

**Optional: Create Desktop Shortcuts**

For easier access, create desktop and start menu shortcuts:

**If installed from PyPI:**
```bash
# Install shortcut support (one-time)
pip install coral-annotation-tool[shortcuts]

# Create shortcuts
cat-create-shortcuts
```

**If installed locally (from source):**
```bash
# Install with shortcut support
pip install -e .[shortcuts]

# Create shortcuts
cat-create-shortcuts

# Or use the helper scripts in the repo:
# Windows: Double-click create_shortcuts.bat
# Mac/Linux: ./create_shortcuts.sh
```

**Remove shortcuts (if needed):**
```bash
cat-remove-shortcuts
```

After creating shortcuts, you can launch CAT from:
- Desktop icon
- Start Menu (Windows) or Applications (Mac/Linux)
- Command line: `cat`

---

## Usage

### Creating Your First Project

1. **Navigate to Project Creator**
   - Open http://localhost:8000
   - Click "Create Project" card

2. **Add Your Data**
   - Drag & drop TIF/GeoTIFF files
   - Optionally add shapefile layers (.shp, .shx, .dbf, .prj)
   - Fill in project metadata (Site, Year, Cruise, Observer, etc.)

3. **Generate Project**
   - Click "Generate Project"
   - Review the JSON structure
   - Download the project file

4. **Start Annotating**
   - Click "Coral Annotation" from homepage
   - Upload your project JSON file
   - Wait for COG conversion (first time only)
   - Begin annotating coral features!

### Annotation Workflow

1. **Select Drawing Tool**
   - 📍 Point - Individual coral colonies
   - ➖ Line - Transects or linear features
   - ⬜ Rectangle - Quick area selection
   - 🔷 Polygon - Complex coral formations

2. **Draw on Map**
   - Click to place vertices
   - Double-click to finish
   - Edit by dragging vertices

3. **Fill Annotation Form**
   - Species (autocomplete with 1000+ species)
   - Morphology, Health, Size
   - Depth, Coverage, Notes

4. **Save Annotation**
   - Press `Ctrl+S` or click Save
   - Annotations auto-sync to project JSON

5. **Export Results**
   - Download updated project JSON
   - Export GeoJSON and/or shapefile for GIS analysis in ArcGIs/QGIS

### Converting TIF to COG
This happens automatically when creating a project, but there is also an additional batch converter included. 
**Via Web Interface:**
1. Navigate to http://localhost:8000/converter
2. Drag & drop GeoTIFF files
3. Select compression type
4. Click "Convert to COG"

**Via Command Line:**

```bash
# Single file conversion
cat-convert input.tif output_cog.tif

# Batch conversion
cat-batch-convert input_folder/ output_folder/

# Or use the Python scripts directly
python scripts/make_cog.py input.tif output_cog.tif
python scripts/make_cog_batch.py input_folder/ output_folder/
```

---

## Annotation Information & Data Format

Annotations are stored in GeoJSON format within project JSON files:
- [Data Dictionary](https://www.fisheries.noaa.gov/inport/item/63239)
- [Metadata](https://www.fisheries.noaa.gov/inport/item/63097)

```json
{
  "type": "Feature",
  "geometry": {
    "type": "Polygon",
    "coordinates": [[[lon1, lat1], [lon2, lat2], ...]]
  },
  "properties": {
    "id": "unique-id",
    "analyst": "Observer Name",
    "spcode": "PLOB",
    "scientific_name": "Porites lobata",
    "obs_year": 2025,
    "mission_id": "SE1902",
    "site": "KAH-608",
    "depth_m": 10.5,
    "health": "H",
    "morph_code": "MD",
    "notes": "Large colony with good coverage",
    "annotation_time_seconds": 45.2
  }
}
```

---

## Coral Species Database

CAT includes a comprehensive coral species reference database with:
- **1000+** coral species
- Scientific names (Genus + Species)
- Common 4-letter species codes
- Autocomplete search functionality
- NOAA coral identification standards

Located in: `data/reference/list_of_coral.csv`

---

## Roadmap
<a href="./docs/example_ai_0.png" target="_blank"><img src="./docs/example_ai_0.png" align="right" alt="logo" /></a>
### 🚧 In Progress
- **AI-Assisted Annotation** - Automated and Semi-automated coral detection, segmentation and classification features (YOLO,SAM3)
- **Google Cloud Storage (GCS) Integration** - Native support for `gs://` bucket paths
- **Cloud Workstation Support** - Optimized deployment for Google Cloud Workstations
- **Database Backend** - Optional Oracle/SQLlite/PostgreSQL/GIS backend for large projects
- **Multi-user Support** - Shared annotation sessions with user tracking
<a href="./docs/example_ai_01.png" target="_blank"><img src="./docs/example_ai_01.png"  alt="logo" /></a>

<a href="./docs/example_ai_02.png" target="_blank"><img src="./docs/example_ai_02.png"  alt="logo" /></a>

### 📋 Planned Features

#### Cloud & Collaboration 
- **Enhanced COG Processing** - Improved batch conversion with progress tracking
- **Other Cloud Storage Integrations** - Support for AWS S3, Azure Blob Storage
- **Real-time Sync** - Live collaboration and annotation syncing

#### Analysis & Visualization
- **Statistics Dashboard** - Project-level analytics and reporting
- **Time-series Analysis** - Multi-temporal change detection
- **Export Formats** - Additional formats (KML, GeoPackage, CSV)

#### Advanced Features 
- **3D Support** - Integration with 3D reef models and point clouds

### 💡 Feature Requests
Have an idea? [Open an issue](https://github.com/MichaelAkridge-NOAA/cat/issues) with the `feature-request` label!

----------
#### Disclaimer
This repository is a scientific product and is not official communication of the National Oceanic and Atmospheric Administration, or the United States Department of Commerce. All NOAA GitHub project content is provided on an ‘as is’ basis and the user assumes responsibility for its use. Any claims against the Department of Commerce or Department of Commerce bureaus stemming from the use of this GitHub project will be governed by all applicable Federal law. Any reference to specific commercial products, processes, or services by service mark, trademark, manufacturer, or otherwise, does not constitute or imply their endorsement, recommendation or favoring by the Department of Commerce. The Department of Commerce seal and logo, or the seal and logo of a DOC bureau, shall not be used in any manner to imply endorsement of any commercial product or activity by DOC or the United States Government.

#### License
This repository's code is available under the terms specified in [LICENSE.md](./LICENSE.md).

## Acknowledgments
This project uses [TiTiler](https://github.com/developmentseed/titiler) by Development Seed for dynamic tile generation. TiTiler is licensed under the [MIT License](https://github.com/developmentseed/titiler/blob/main/LICENSE).
