// ============================================================
//  CAT v2 — Enhanced Table Features
//  Sortable columns, resizable panel, arrow-key navigation,
//  batch/bulk column fill, column visibility manager
// ============================================================

(function () {
  'use strict';

  // ── State ──
  let sortColumn = null;
  let sortDirection = 'asc';    // 'asc' | 'desc'
  let kbRow = -1;               // keyboard-nav row index
  let kbCol = -1;               // keyboard-nav col index
  let tableSizeMode = 'md';     // 'sm' | 'md' | 'lg' | 'xl'
  let clipboard = null;         // copy/paste buffer
  let selectedCells = [];       // multi-select cells {row, col, value}

  const TABLE_SIZES = {
    sm: 120,
    md: 200,
    lg: 350,
    xl: 500
  };

  // Column definitions — field name → header display name
  // Order matches the <th> elements in the HTML
  const COLUMNS = [
    { field: 'id',            label: 'ID',            sortable: true,  batchFill: false, visible: true  },
    { field: 'type',          label: 'Type',          sortable: true,  batchFill: false, visible: false },
    { field: 'site',          label: 'Site',          sortable: true,  batchFill: true,  visible: true  },
    { field: 'spcode',        label: 'Species',       sortable: true,  batchFill: true,  visible: true  },
    { field: 'juvenile',      label: 'Juvenile',      sortable: true,  batchFill: true,  visible: true  },
    { field: 'juv_substrate', label: 'JUV_SUBSTRATE', sortable: true,  batchFill: true,  visible: true  },
    { field: 'analyst',       label: 'Analyst',       sortable: true,  batchFill: true,  visible: false },
    { field: 'obs_year',      label: 'Year',          sortable: true,  batchFill: true,  visible: false },
    { field: 'mission_id',    label: 'Mission',       sortable: true,  batchFill: true,  visible: false },
    { field: 'segment',       label: 'Segment',       sortable: true,  batchFill: true,  visible: true  },
    { field: 'transect',      label: 'Transect',      sortable: true,  batchFill: true,  visible: true  },
    { field: 'morph_code',    label: 'Morph',         sortable: true,  batchFill: true,  visible: true  },
    { field: 'olddead',       label: 'Old Dead %',    sortable: true,  batchFill: true,  visible: false },
    { field: 'actions',       label: 'Actions',       sortable: false, batchFill: false, visible: true  }
  ];

  // ===================================================================
  //  SORT — click header to sort annotation table
  // ===================================================================
  function initSortableHeaders() {
    // We hook into updateAnnotationTable to re-apply sort after table refresh
    const origUpdate = window.updateAnnotationTable;
    if (typeof origUpdate === 'function') {
      window.updateAnnotationTable = function () {
        origUpdate.apply(this, arguments);
        applySortableHeaders();
        applyTableSize();
        if (sortColumn) {
          sortTableByColumn(sortColumn, sortDirection, false); // re-sort without re-rendering
        }
      };
    }
  }

  function applySortableHeaders() {
    const table = document.getElementById('annotationTable');
    if (!table) return;
    const headers = table.querySelectorAll('thead th');

    headers.forEach((th, idx) => {
      const col = COLUMNS[idx];
      if (!col || !col.sortable) return;

      th.classList.add('sortable');
      if (col.batchFill) {
        th.classList.add('batch-fillable');
        // Add batch-fill button
        if (!th.querySelector('.batch-fill-btn')) {
          const btn = document.createElement('button');
          btn.className = 'batch-fill-btn';
          btn.title = `Batch fill "${col.label}" for all rows`;
          btn.textContent = '⬇';
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openBatchFillModal(col.field, col.label);
          });
          th.style.position = 'relative';
          th.appendChild(btn);
        }
      }

      // Update sort indicator
      th.classList.remove('sort-asc', 'sort-desc');
      if (sortColumn === col.field) {
        th.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
      }

      // Click handler
      th.onclick = () => {
        if (sortColumn === col.field) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = col.field;
          sortDirection = 'asc';
        }
        sortTableByColumn(sortColumn, sortDirection, true);
      };
    });
  }

  function sortTableByColumn(field, direction, reRender) {
    const table = document.getElementById('annotationTable');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    if (rows.length <= 1 && rows[0] && rows[0].cells.length === 1) return; // "no annotations" row

    rows.sort((a, b) => {
      const colIdx = COLUMNS.findIndex(c => c.field === field);
      if (colIdx === -1) return 0;
      const aText = (a.cells[colIdx]?.textContent || '').trim();
      const bText = (b.cells[colIdx]?.textContent || '').trim();

      // Try numeric sort
      const aNum = parseFloat(aText);
      const bNum = parseFloat(bText);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return direction === 'asc' ? aNum - bNum : bNum - aNum;
      }
      // String sort
      const cmp = aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' });
      return direction === 'asc' ? cmp : -cmp;
    });

    rows.forEach(row => tbody.appendChild(row));

    // Update header indicators
    applySortableHeaders();
  }

  // ===================================================================
  //  TABLE SIZE — resizable annotation panel
  // ===================================================================
  function injectTableSizeControls() {
    const waitForPanel = setInterval(() => {
      const listHeader = document.querySelector('#annotationsListSectionContent')?.previousElementSibling;
      if (!listHeader) return;
      clearInterval(waitForPanel);

      // Insert size buttons
      const controls = document.createElement('div');
      controls.className = 'table-size-controls';
      controls.id = 'v2TableSizeControls';
      controls.innerHTML = `
        <button class="table-size-btn" data-size="sm" title="Small table">S</button>
        <button class="table-size-btn active" data-size="md" title="Medium table">M</button>
        <button class="table-size-btn" data-size="lg" title="Large table">L</button>
        <button class="table-size-btn" data-size="xl" title="Extra-large table">XL</button>
      `;

      // Append next to the h3
      const h3 = listHeader.querySelector('h3') || listHeader.querySelector('div');
      if (h3) {
        h3.parentElement.appendChild(controls);
      }

      controls.addEventListener('click', (e) => {
        const btn = e.target.closest('.table-size-btn');
        if (!btn) return;
        e.stopPropagation(); // Prevent parent section collapse toggle
        tableSizeMode = btn.dataset.size;
        controls.querySelectorAll('.table-size-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyTableSize();
      });

      // Also add drag-resize handle to annotation panel
      const panel = document.getElementById('annotationFormPanel');
      if (panel && !panel.querySelector('.resize-handle')) {
        panel.style.position = 'absolute'; // ensure positioning
        const handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.title = 'Drag to resize';
        panel.insertBefore(handle, panel.firstChild);

        let startY, startH;
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation(); // Prevent parent handlers
          startY = e.clientY;
          startH = panel.offsetHeight;
          handle.classList.add('dragging');
          const onMove = (ev) => {
            const delta = startY - ev.clientY;
            const newH = Math.max(80, Math.min(window.innerHeight * 0.85, startH + delta));
            panel.style.maxHeight = newH + 'px';
          };
          const onUp = () => {
            handle.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
      }
    }, 300);
  }

  function applyTableSize() {
    const container = document.querySelector('.annotation-table-container');
    if (container) {
      container.style.maxHeight = TABLE_SIZES[tableSizeMode] + 'px';
      container.style.minHeight = Math.min(80, TABLE_SIZES[tableSizeMode]) + 'px';
    }
  }

  // ===================================================================
  //  ARROW KEY NAV — move between editable cells with arrow keys
  // ===================================================================
  function initArrowKeyNav() {
    document.addEventListener('keydown', function (e) {
      const table = document.getElementById('annotationTable');
      if (!table) return;

      // Copy/Paste shortcuts
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        handleCopy(e);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        handlePaste(e);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        handleDuplicateDown(e);
        return;
      }

      // Arrow key navigation
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab'].includes(e.key)) return;

      // Only activate if we have a focused cell or the table is focused
      const activeCell = table.querySelector('td.kb-focus');
      if (!activeCell && document.activeElement.tagName !== 'TD') return;
      if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
        // Allow Enter/Tab to move to next cell after editing
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const td = document.activeElement.closest('td');
          if (td) {
            document.activeElement.blur();
            const row = td.parentElement;
            const cells = Array.from(row.cells);
            const colIdx = cells.indexOf(td);
            const rows = Array.from(table.querySelector('tbody').querySelectorAll('tr'));
            const rowIdx = rows.indexOf(row);
            
            if (e.key === 'Tab') {
              // Tab moves right (or to next row)
              if (e.shiftKey) {
                navigateToCell(table, rowIdx, colIdx - 1);
              } else {
                navigateToCell(table, rowIdx, colIdx + 1);
              }
            } else {
              // Enter moves down
              navigateToCell(table, rowIdx + 1, colIdx);
            }
          }
        }
        return;
      }

      e.preventDefault();
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0) return;

      // Get editable cells
      if (activeCell) {
        kbRow = rows.indexOf(activeCell.parentElement);
        kbCol = Array.from(activeCell.parentElement.cells).indexOf(activeCell);
      }

      // Move
      if (e.key === 'ArrowUp')    kbRow = Math.max(0, kbRow - 1);
      if (e.key === 'ArrowDown')  kbRow = Math.min(rows.length - 1, kbRow + 1);
      if (e.key === 'ArrowLeft')  kbCol = Math.max(0, kbCol - 1);
      if (e.key === 'ArrowRight') kbCol = Math.min((rows[kbRow]?.cells.length || 1) - 1, kbCol + 1);

      navigateToCell(table, kbRow, kbCol);
    });

    // Click on cell to focus
    document.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td) return;
      const table = td.closest('table');
      if (!table || table.id !== 'annotationTable') return;

      // Clear previous focus unless Ctrl is held (multi-select)
      if (!e.ctrlKey && !e.metaKey) {
        table.querySelectorAll('td.kb-focus').forEach(cell => cell.classList.remove('kb-focus'));
      }

      td.classList.add('kb-focus');
      const row = td.parentElement;
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      kbRow = rows.indexOf(row);
      kbCol = Array.from(row.cells).indexOf(td);
    });
  }

  function navigateToCell(table, rowIdx, colIdx) {
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    
    // Wrap to next/prev row if out of bounds
    if (colIdx < 0 && rowIdx > 0) {
      rowIdx--;
      const prevRow = rows[rowIdx];
      colIdx = prevRow ? prevRow.cells.length - 1 : 0;
    } else if (colIdx >= (rows[rowIdx]?.cells.length || 0) && rowIdx < rows.length - 1) {
      rowIdx++;
      colIdx = 0;
    }

    // Clamp to valid range
    rowIdx = Math.max(0, Math.min(rows.length - 1, rowIdx));
    const targetRow = rows[rowIdx];
    if (!targetRow) return;
    colIdx = Math.max(0, Math.min(targetRow.cells.length - 1, colIdx));

    // Clear all highlights
    table.querySelectorAll('td.kb-focus').forEach(td => td.classList.remove('kb-focus'));

    // Apply new focus
    const cell = targetRow.cells[colIdx];
    if (cell) {
      cell.classList.add('kb-focus');
      cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      cell.focus();
      kbRow = rowIdx;
      kbCol = colIdx;
    }
  }

  // ===================================================================
  //  COPY / PASTE / DUPLICATE
  // ===================================================================
  function handleCopy(e) {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const focusedCells = Array.from(table.querySelectorAll('td.kb-focus'));
    if (focusedCells.length === 0) return;

    e.preventDefault();

    // Get cell values
    const values = focusedCells.map(td => {
      const input = td.querySelector('input, select');
      return input ? input.value : td.textContent.trim();
    });

    clipboard = values;
    focusedCells.forEach(td => {
      td.classList.remove('copied');
      // restart animation
      void td.offsetWidth;
      td.classList.add('copied');
    });

    // Copy to system clipboard as well
    const textToCopy = values.join('\t');
    if (e.clipboardData) {
      e.clipboardData.setData('text/plain', textToCopy);
    }
    navigator.clipboard.writeText(textToCopy).then(() => {
      showToast(`📋 Copied ${values.length} cell(s)`, 'info');
    }).catch(() => {
      showToast(`📋 Copied ${values.length} cell(s) (internal only)`, 'info');
    });
  }

  function handlePaste(e) {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const focusedCell = table.querySelector('td.kb-focus');
    if (!focusedCell) return;

    e.preventDefault();

    // Prefer clipboard payload from the current paste event
    const eventText = e.clipboardData?.getData('text/plain');
    if (eventText) {
      const values = eventText.split(/\r?\n|\t/).filter(v => v !== '');
      pasteValues(focusedCell, values.length ? values : [eventText]);
      return;
    }

    // Try to get from system clipboard first
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(text => {
      const values = text.split('\t');
      pasteValues(focusedCell, values.length === 1 ? clipboard || values : values);
      }).catch(() => {
        // Fall back to internal clipboard
        if (clipboard && clipboard.length > 0) {
          pasteValues(focusedCell, clipboard);
        }
      });
    } else if (clipboard && clipboard.length > 0) {
      pasteValues(focusedCell, clipboard);
    }
  }

  function pasteValues(startCell, values) {
    if (!values || values.length === 0) return;

    const table = startCell.closest('table');
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const startRow = startCell.parentElement;
    const startRowIdx = rows.indexOf(startRow);
    const startColIdx = Array.from(startRow.cells).indexOf(startCell);

    let pastedCount = 0;

    // If single value, paste to all focused cells
    const focusedCells = Array.from(table.querySelectorAll('td.kb-focus'));
    if (values.length === 1 && focusedCells.length > 1) {
      focusedCells.forEach(td => {
        if (setCellValue(td, values[0])) pastedCount++;
      });
    } else {
      // Paste values sequentially down the column
      for (let i = 0; i < values.length && startRowIdx + i < rows.length; i++) {
        const targetRow = rows[startRowIdx + i];
        const targetCell = targetRow.cells[startColIdx];
        if (targetCell && setCellValue(targetCell, values[i])) {
          pastedCount++;
        }
      }
    }

    if (pastedCount > 0) {
      showToast(`📥 Pasted to ${pastedCount} cell(s)`, 'success');
      // Trigger save
      if (typeof hasUnsavedChanges !== 'undefined') {
        hasUnsavedChanges = true;
      }
    }
  }

  function handleDuplicateDown(e) {
    const table = document.getElementById('annotationTable');
    if (!table) return;

    const focusedCell = table.querySelector('td.kb-focus');
    if (!focusedCell) return;

    const input = focusedCell.querySelector('input, select');
    const field = focusedCell.dataset.field;
    let value = input ? input.value : (focusedCell.textContent || '').trim();
    if (!input && field === 'old_dead') value = value.replace('%', '').trim();
    if (!input && field === 'juvenile') {
      if (value.toLowerCase() === 'yes') value = '-1';
      if (value.toLowerCase() === 'no') value = '0';
      if (value === '-') value = '';
    }
    if (!value) return;

    // Find all rows below and fill the same column
    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const startRow = focusedCell.parentElement;
    const startRowIdx = rows.indexOf(startRow);
    const colIdx = Array.from(startRow.cells).indexOf(focusedCell);

    let filledCount = 0;
    for (let i = startRowIdx + 1; i < rows.length; i++) {
      const targetCell = rows[i].cells[colIdx];
      if (targetCell && setCellValue(targetCell, value)) {
        filledCount++;
      }
    }

    if (filledCount > 0) {
      showToast(`⬇ Duplicated "${value}" to ${filledCount} cell(s) below`, 'success');
      if (typeof hasUnsavedChanges !== 'undefined') {
        hasUnsavedChanges = true;
      }
    }
  }

  function setCellValue(td, value) {
    const input = td.querySelector('input');
    const select = td.querySelector('select');

    if (input) {
      input.value = value;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } else if (select) {
      // Try to match the value or text
      const option = Array.from(select.options).find(opt => 
        opt.value === value || opt.text === value
      );
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }

    // Static table cell mode (most v2 cells render as text until edited)
    if (td.classList.contains('editable') && typeof window.makeTableCellEditable === 'function') {
      window.makeTableCellEditable(td);
      const editor = td.querySelector('input, select');
      if (!editor) return false;

      const rawValue = (value ?? '').toString().trim();
      if (editor.tagName === 'SELECT') {
        const option = Array.from(editor.options).find(opt => opt.value === rawValue || opt.text === rawValue);
        editor.value = option ? option.value : rawValue;
      } else {
        editor.value = rawValue === '-' ? '' : rawValue;
      }

      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    }

    return false;
  }

  function showToast(message, type) {
    if (typeof window.showStatus === 'function') {
      window.showStatus(message, type);
    } else {
      console.log(message);
    }
  }

  // ===================================================================
  //  BATCH FILL MODAL — fill a column for all (or selected) rows
  // ===================================================================
  function injectBatchFillModal() {
    const modal = document.createElement('div');
    modal.className = 'batch-fill-modal';
    modal.id = 'v2BatchFillModal';
    modal.innerHTML = `
      <div class="batch-fill-content">
        <h3>⬇ Batch Fill: <span id="batchFillColName"></span></h3>
        <div class="batch-scope">
          <label><input type="radio" name="batchScope" value="all" checked> All rows</label>
          <label><input type="radio" name="batchScope" value="empty"> Empty cells only</label>
        </div>
        <div class="batch-input-row">
          <div id="batchFillInputContainer" style="flex:1;"></div>
        </div>
        <div class="batch-fill-actions">
          <button class="btn btn-secondary" onclick="document.getElementById('v2BatchFillModal').classList.remove('active')">Cancel</button>
          <button class="btn btn-primary" id="batchFillApplyBtn">⬇ Apply to All</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });
  }

  let currentBatchField = null;

  function openBatchFillModal(field, label) {
    currentBatchField = field;
    document.getElementById('batchFillColName').textContent = label;
    const container = document.getElementById('batchFillInputContainer');

    // Build the appropriate input
    const dropdownFields = {
      morph_code: [
        { v: '', l: '- Select -' },
        { v: 'BR', l: 'BR - Branching' }, { v: 'CO', l: 'CO - Columnar' },
        { v: 'EN', l: 'EN - Encrusting' }, { v: 'FO', l: 'FO - Foliaceous' },
        { v: 'FL', l: 'FL - Free-living' }, { v: 'LA', l: 'LA - Laminar' },
        { v: 'MD', l: 'MD - Mounding' }, { v: 'MA', l: 'MA - Massive' },
        { v: 'PL', l: 'PL - Plating' }, { v: 'SM', l: 'SM - Submassive' },
        { v: 'SO', l: 'SO - Solitary' }, { v: 'TB', l: 'TB - Tabular' }
      ],
      transect: [
        { v: '', l: '- Select -' }, { v: 'A', l: 'A' }, { v: 'B', l: 'B' }
      ],
      segment: [
        { v: '', l: '- Select -' }, { v: '0', l: '0' }, { v: '5', l: '5' }, { v: '10', l: '10' }, { v: '15', l: '15' }
      ],
      juvenile: [
        { v: '0', l: 'No (0)' }, { v: '-1', l: 'Yes (-1)' }
      ]
    };

    if (dropdownFields[field]) {
      const options = dropdownFields[field].map(o => `<option value="${o.v}">${o.l}</option>`).join('');
      container.innerHTML = `<select id="batchFillValue" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">${options}</select>`;
    } else {
      container.innerHTML = `<input type="text" id="batchFillValue" placeholder="Enter value for all rows" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px;">`;
    }

    // Wire apply button
    document.getElementById('batchFillApplyBtn').onclick = () => applyBatchFill();

    document.getElementById('v2BatchFillModal').classList.add('active');
    setTimeout(() => document.getElementById('batchFillValue')?.focus(), 100);
  }

  function applyBatchFill() {
    if (!currentBatchField) return;
    const valueEl = document.getElementById('batchFillValue');
    if (!valueEl) return;
    let value = valueEl.value;

    // Check if uppercase mode is on (for text fields)
    const isAllCaps = document.body.classList.contains('v2-allcaps');
    if (isAllCaps && typeof value === 'string') {
      value = value.toUpperCase();
    }

    const scope = document.querySelector('input[name="batchScope"]:checked')?.value || 'all';

    if (typeof annotations === 'undefined') return;

    let count = 0;
    annotations.forEach((ann) => {
      const props = ann.properties || ann;
      const currentVal = props[currentBatchField] || '';

      if (scope === 'empty' && currentVal !== '') return; // skip non-empty

      props[currentBatchField] = value;
      // Also update flat top-level field so table display and Oracle save stay in sync
      ann[currentBatchField] = value;
      count++;
    });

    // Sync to layers
    if (typeof drawnItems !== 'undefined') {
      drawnItems.eachLayer(layer => {
        if (layer.annotationData) {
          const props = layer.annotationData.properties || layer.annotationData;
          if (scope === 'all' || !props[currentBatchField]) {
            props[currentBatchField] = value;
          }
        }
      });
    }

    // Mark unsaved
    if (typeof hasUnsavedChanges !== 'undefined') {
      hasUnsavedChanges = true;
    }

    // Update table
    if (typeof updateAnnotationTable === 'function') {
      updateAnnotationTable();
    }

    document.getElementById('v2BatchFillModal').classList.remove('active');

    // Show toast
    if (typeof showStatus === 'function') {
      showStatus(`⬇ Batch filled "${currentBatchField}" → "${value}" (${count} rows)`, 'success');
    }
  }

  // ===================================================================
  //  KEYBOARD SHORTCUTS HINT
  // ===================================================================
  function injectKeyboardHelpHint() {
    // Add small hint badge near the table
    const waitForTable = setInterval(() => {
      const table = document.getElementById('annotationTable');
      if (!table) return;
      clearInterval(waitForTable);

      if (document.getElementById('v2TableShortcutsHint')) return;

      const hint = document.createElement('div');
      hint.id = 'v2TableShortcutsHint';
      hint.className = 'kb-shortcuts-hint';
      const isCollapsed = localStorage.getItem('v2.tableShortcuts.collapsed') === '1';
      hint.innerHTML = `
        <div class="kb-shortcuts-header" style="display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:pointer;">
          <div style="font-size: 11px; font-weight: 600;">⌨️ Table Shortcuts</div>
          <button type="button" id="v2TableShortcutsToggle" style="border:none; background:#fff; border-radius:4px; padding:2px 8px; font-size:11px; cursor:pointer;">${isCollapsed ? '▶' : '▼'}</button>
        </div>
        <div id="v2TableShortcutsBody" style="font-size: 10px; line-height: 1.6; color: rgba(0,0,0,0.7); margin-top:6px; ${isCollapsed ? 'display:none;' : ''}">
          <div><kbd>↑↓←→</kbd> Navigate • <kbd>Enter/Tab</kbd> Next cell</div>
          <div><kbd>Ctrl+C</kbd> Copy • <kbd>Ctrl+V</kbd> Paste • <kbd>Ctrl+D</kbd> Duplicate down</div>
          <div>Click <strong>⬇</strong> on header to batch-fill column</div>
        </div>
      `;

      // Insert above the table
      const container = table.closest('.annotation-table-container');
      if (container && container.parentElement) {
        container.parentElement.insertBefore(hint, container);
      }

      const toggleBtn = document.getElementById('v2TableShortcutsToggle');
      const body = document.getElementById('v2TableShortcutsBody');
      const setCollapsed = (collapsed) => {
        if (!toggleBtn || !body) return;
        body.style.display = collapsed ? 'none' : 'block';
        toggleBtn.textContent = collapsed ? '▶' : '▼';
        localStorage.setItem('v2.tableShortcuts.collapsed', collapsed ? '1' : '0');
      };

      hint.querySelector('.kb-shortcuts-header')?.addEventListener('click', (evt) => {
        evt.stopPropagation();
        const collapsedNow = body.style.display === 'none';
        setCollapsed(!collapsedNow);
      });

      // Expose for bulk mode automation
      window.setTableShortcutsCollapsed = setCollapsed;
    }, 300);
  }

  function initClipboardEvents() {
    document.addEventListener('copy', (e) => {
      const table = document.getElementById('annotationTable');
      if (!table || !table.querySelector('td.kb-focus')) return;
      handleCopy(e);
    });

    document.addEventListener('paste', (e) => {
      const table = document.getElementById('annotationTable');
      if (!table || !table.querySelector('td.kb-focus')) return;
      handlePaste(e);
    });
  }

  // ===================================================================
  //  INIT
  // ===================================================================
  function init() {
    initSortableHeaders();
    injectTableSizeControls();
    initArrowKeyNav();
    initClipboardEvents();
    injectBatchFillModal();
    injectKeyboardHelpHint();
    console.log('🔧 v2-table.js loaded — Sort, Resize, Arrow Keys, Copy/Paste, Batch Fill');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Delay slightly to let v1 modules register first
    setTimeout(init, 100);
  }

})();
