"""
API endpoints for coral species lookup and autocomplete
"""
import csv
import os
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from typing import List, Dict

router = APIRouter(prefix="/api/coral", tags=["coral"])

# Cache the species list in memory
_species_cache = None

def load_species_list() -> List[Dict]:
    """Load coral species from CSV file"""
    global _species_cache
    
    if _species_cache is not None:
        return _species_cache
    
    # Get path to the reference data in the package
    csv_path = Path(__file__).parent.parent / 'data' / 'reference' / 'list_of_coral.csv'
    
    if not csv_path.exists():
        print(f"⚠️ Species CSV not found at: {csv_path}")
        return []
    
    species_list = []
    try:
        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                species_list.append({
                    'code': row.get('SPECIES', ''),
                    'taxon_name': row.get('TAXONNAME', ''),
                    'scientific_name': row.get('SCIENTIFIC_NAME', ''),
                    'genus': row.get('GENUS', ''),
                    'family': row.get('FAMILY', ''),
                    'morphology': f"{row.get('MORPHOLOGY_1', '')} {row.get('MORPHOLOGY_2', '')}".strip(),
                    'class': row.get('CLASS', ''),
                })
        
        _species_cache = species_list
    except Exception as e:
        print(f"Error loading species list: {e}")
        return []
    
    return species_list


@router.get("/species")
async def get_all_species():
    """Get complete list of coral species"""
    species = load_species_list()
    return {
        "count": len(species),
        "species": species
    }


@router.get("/species/search")
async def search_species(
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(10, ge=1, le=100, description="Maximum results")
):
    """
    Search coral species by code, taxon name, or scientific name
    Returns matching species sorted by relevance
    """
    species_list = load_species_list()
    
    if not species_list:
        return {"results": []}
    
    query = q.lower().strip()
    results = []
    
    for species in species_list:
        score = 0
        
        # Exact match on code (highest priority)
        if species['code'].lower() == query:
            score = 100
        # Starts with query (high priority)
        elif species['code'].lower().startswith(query):
            score = 90
        # Contains query in code
        elif query in species['code'].lower():
            score = 80
        # Starts with query in taxon name
        elif species['taxon_name'].lower().startswith(query):
            score = 70
        # Contains query in taxon name
        elif query in species['taxon_name'].lower():
            score = 60
        # Contains query in scientific name
        elif query in species['scientific_name'].lower():
            score = 50
        # Contains query in genus
        elif query in species['genus'].lower():
            score = 40
        
        if score > 0:
            results.append({
                **species,
                'score': score
            })
    
    # Sort by score (descending) and then by code
    results.sort(key=lambda x: (-x['score'], x['code']))
    
    # Limit results
    results = results[:limit]
    
    return {
        "query": q,
        "count": len(results),
        "results": results
    }


@router.get("/species/{code}")
async def get_species_by_code(code: str):
    """Get detailed information for a specific species code"""
    species_list = load_species_list()
    
    code_upper = code.upper()
    
    for species in species_list:
        if species['code'].upper() == code_upper:
            return species
    
    raise HTTPException(status_code=404, detail=f"Species code '{code}' not found")
