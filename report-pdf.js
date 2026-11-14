/* Hall Pilot print-ready PDF reports.
 * Runs locally in the authorized user's browser. No report data is sent
 * to a third-party PDF service. Requires locally hosted jsPDF + AutoTable.
 */
(function (root) {
  'use strict';

  const NAVY = [16, 46, 89];
  const BLUE = [31, 94, 168];
  const INK = [32, 45, 62];
  const MUTED = [87, 103, 123];
  const PALE = [238, 244, 251];
  const BORDER = [219, 229, 239];
  const PAGE_MARGIN = 39;
  const fontPromises = new Map();
  let brandMarkPromise;

  function plain(value) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .trim();
  }

  function safeName(value) {
    return plain(value).replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 110) || 'hall-pass-report';
  }

  function cellText(cell) {
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.sortArrow,.reportExpandButton').forEach(function (node) {
      node.remove();
    });
    clone.querySelectorAll('br').forEach(function (node) {
      node.replaceWith(document.createTextNode(' / '));
    });
    clone.querySelectorAll('.muted').forEach(function (node) {
      node.textContent = ' (' + plain(node.textContent) + ')';
    });
    clone.querySelectorAll('.reportFlag').forEach(function (node) {
      node.textContent = plain(node.textContent) + '; ';
    });
    return plain(clone.textContent).replace(/\s+/g, ' ');
  }

  function fromTable(head, body, rowSelector) {
    if (!head || !body) return { headers: [], rows: [] };
    const headers = Array.from(head.querySelectorAll('tr:first-child th')).map(cellText);
    const rowNodes = Array.from(body.querySelectorAll(rowSelector || 'tr'));
    const rows = rowNodes.map(function (row) {
      return Array.from(row.children)
        .filter(function (cell) { return cell.tagName === 'TD'; })
        .map(cellText);
    }).filter(function (row) {
      return row.length === headers.length &&
        !(row.length === 1 && /no matching|no passes|no students/i.test(row[0]));
    });
    return { headers: headers, rows: rows };
  }

  async function getFont(name, directory) {
    const url = directory + name;
    if (!fontPromises.has(url)) {
      fontPromises.set(url, fetch(url, { credentials: 'same-origin' }).then(function (response) {
        if (!response.ok) throw new Error('Unable to load local PDF font: ' + name);
        return response.arrayBuffer();
      }).then(function (buffer) {
        const bytes = new Uint8Array(buffer);
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 16384) {
          chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 16384)));
        }
        return chunks.join('');
      }).catch(function (error) {
        fontPromises.delete(url);
        throw error;
      }));
    }
    return fontPromises.get(url);
  }

  async function installFonts(doc, directory) {
    const values = await Promise.all([
      getFont('Lato-Regular.ttf', directory),
      getFont('Lato-Bold.ttf', directory)
    ]);
    doc.addFileToVFS('HallPilot-Lato-Regular.ttf', values[0]);
    doc.addFileToVFS('HallPilot-Lato-Bold.ttf', values[1]);
    doc.addFont('HallPilot-Lato-Regular.ttf', 'HallPilotLato', 'normal');
    doc.addFont('HallPilot-Lato-Bold.ttf', 'HallPilotLato', 'bold');
    doc.setFont('HallPilotLato', 'normal');
    return 'HallPilotLato';
  }

  // Use the same Hall Pilot mark that appears in the live site header.
  // Rasterizing the local SVG allows jsPDF to embed it without external services.
  function loadBrandMark() {
    if (!brandMarkPromise) {
      brandMarkPromise = new Promise(function (resolve) {
        const image = new Image();
        image.onload = function () {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 480;
            canvas.height = 345;
            const context = canvas.getContext('2d');
            if (!context) { resolve(null); return; }
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/png'));
          } catch (error) {
            resolve(null);
          }
        };
        image.onerror = function () { resolve(null); };
        image.src = 'assets/hall-pilot-mark.svg';
      });
    }
    return brandMarkPromise;
  }

  // Keep metadata labels prominent without bolding their values.
  // Supports multiple labels on a line, such as School: ... Room: D4.
  function drawDetail(doc, detail, startY, width, font) {
    const fragments = detail.split(/(School:|Reporting period:|Period:|Room:|Destination:|Student:)/gi).filter(Boolean);
    const maxX = width - PAGE_MARGIN;
    let x = PAGE_MARGIN, y = startY;
    doc.setFontSize(9);
    fragments.forEach(function (fragment) {
      const isLabel = /^(School:|Reporting period:|Period:|Room:|Destination:|Student:)$/i.test(fragment);
      const output = /^Reporting period:$/i.test(fragment) ? 'Reporting Period:' : fragment;
      doc.setFont(font, isLabel ? 'bold' : 'normal');
      doc.setTextColor.apply(doc, isLabel ? INK : MUTED);
      (output.match(/\s+|\S+/g) || []).forEach(function (part) {
        const isSpace = !part.trim();
        if (isSpace && x === PAGE_MARGIN) return;
        const partWidth = doc.getTextWidth(part);
        if (!isSpace && x + partWidth > maxX && x > PAGE_MARGIN) {
          y += 12;
          x = PAGE_MARGIN;
        }
        if (isSpace && x + partWidth > maxX) return;
        doc.text(part, x, y);
        x += partWidth;
      });
    });
    doc.setFont(font, 'normal');
    doc.setTextColor.apply(doc, MUTED);
    return y + 14;
  }

  function drawBanner(doc, width, font, brandMark) {
    doc.setFillColor.apply(doc, NAVY);
    doc.rect(0, 0, width, 9, 'F');
    doc.setFont(font, 'bold');
    doc.setFontSize(12);
    doc.setTextColor.apply(doc, NAVY);
    if (brandMark) doc.addImage(brandMark, 'PNG', PAGE_MARGIN, 17, 31, 22);
    const markOffset = brandMark ? 38 : 0;
    doc.text('HALL PILOT', PAGE_MARGIN + markOffset, 39);
    doc.setFont(font, 'normal');
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, MUTED);
    doc.text('Hall Pass Reporting', PAGE_MARGIN + markOffset + 86, 39);
    doc.setFontSize(7);
    doc.text('CONFIDENTIAL  /  SCHOOL USE', width - PAGE_MARGIN, 39, { align: 'right' });
    doc.setDrawColor.apply(doc, BORDER);
    doc.setLineWidth(.8);
    doc.line(PAGE_MARGIN, 49, width - PAGE_MARGIN, 49);
  }

  function drawFooter(doc, page, total, width, height, font, generated) {
    doc.setDrawColor.apply(doc, BORDER);
    doc.setLineWidth(.6);
    doc.line(PAGE_MARGIN, height - 40, width - PAGE_MARGIN, height - 40);
    doc.setTextColor.apply(doc, MUTED);
    doc.setFont(font, 'normal');
    doc.setFontSize(7.4);
    doc.text('Confidential student information  •  Handle and share only with authorized personnel', PAGE_MARGIN, height - 25);
    doc.text('Page ' + page + ' of ' + total, width - PAGE_MARGIN, height - 25, { align: 'right' });
    doc.setFontSize(6.8);
    doc.text('Generated ' + generated, PAGE_MARGIN, height - 13);
  }

  function drawSummary(doc, items, startY, width, font) {
    if (!items.length) return startY;
    const cols = 4, gap = 9;
    const cellW = (width - 2 * PAGE_MARGIN - gap * (cols - 1)) / cols;
    const height = 44;
    const lines = Math.ceil(items.length / cols);
    items.forEach(function (item, index) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const x = PAGE_MARGIN + col * (cellW + gap);
      const y = startY + row * (height + 8);
      doc.setFillColor.apply(doc, PALE);
      doc.setDrawColor.apply(doc, BORDER);
      doc.roundedRect(x, y, cellW, height, 5, 5, 'FD');
      doc.setTextColor.apply(doc, MUTED);
      doc.setFont(font, 'normal');
      doc.setFontSize(7.5);
      let title = plain(item[0]);
      while (doc.getTextWidth(title) > cellW - 17 && title.length > 6) {
        title = title.slice(0, -2) + '…';
      }
      doc.text(title, x + 9, y + 15);
      doc.setTextColor.apply(doc, NAVY);
      doc.setFont(font, 'bold');
      doc.setFontSize(13);
      const value = plain(item[1] || '0');
      doc.text(value.length > 30 ? value.slice(0, 27) + '…' : value, x + 9, y + 34);
    });
    return startY + lines * (height + 8) + 7;
  }

  async function exportPdf(options) {
    const pdfFactory = root.jspdf && root.jspdf.jsPDF;
    if (typeof pdfFactory !== 'function') {
      throw new Error('PDF generator did not load. Refresh the page and try again.');
    }
    // Use legal landscape for wider detail tables, Letter for normal reports.
    const widestTable = Math.max(0, ...(options.tables || []).map(function (table) {
      return (table && table.headers || []).length;
    }));
    const doc = new pdfFactory({ orientation: 'landscape', unit: 'pt', format: widestTable >= 10 ? 'legal' : 'letter', compress: true, putOnlyUsedFonts: true });
    if (typeof doc.autoTable !== 'function' && !(root.jspdfAutoTable && root.jspdfAutoTable.autoTable)) {
      throw new Error('PDF table renderer did not load. Refresh the page and try again.');
    }
    const font = await installFonts(doc, options.fontDirectory || 'vendor/fonts/');
    const brandMark = await loadBrandMark();
    const width = doc.internal.pageSize.getWidth(), height = doc.internal.pageSize.getHeight();
    const generated = new Date().toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
    const title = plain(options.title || 'Hall Pass Report');
    doc.setProperties({
      title: title + ' | Hall Pilot',
      subject: plain(options.scope || '') + ' hall pass report',
      author: 'Hall Pilot',
      keywords: 'hall passes, school report'
    });
    drawBanner(doc, width, font, brandMark);

    let y = 76;
    doc.setFont(font, 'bold');
    doc.setFontSize(19);
    doc.setTextColor.apply(doc, INK);
    const titleLines = doc.splitTextToSize(title, width - PAGE_MARGIN * 2);
    doc.text(titleLines, PAGE_MARGIN, y);
    y += titleLines.length * 22 + 4;

    const details = (options.details || []).map(plain).filter(Boolean);
    details.forEach(function (detail) {
      y = drawDetail(doc, detail, y, width, font);
    });
    y += 12;
    const summaries = (options.summary || []).map(function (entry) {
      return [plain(entry[0]), plain(entry[1])];
    }).slice(0, 12);
    y = drawSummary(doc, summaries, y, width, font);
    y += 5;

    const tables = (options.tables || []).filter(function (t) { return t && t.headers && t.headers.length; });
    if (!tables.length) {
      doc.setFont(font, 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, MUTED);
      doc.text('No report table is available for the current selection.', PAGE_MARGIN, y + 15);
    }
    for (let index = 0; index < tables.length; index++) {
      const table = tables[index];
      if (y > height - 145) {
        doc.addPage(); drawBanner(doc, width, font, brandMark); y = 75;
      }
      doc.setFont(font, 'bold');
      doc.setFontSize(11);
      doc.setTextColor.apply(doc, BLUE);
      const tableTitle = plain(table.title || 'Report Details');
      doc.text(tableTitle, PAGE_MARGIN, y);
      y += 11;
      const heads = table.headers.map(plain);
      const body = (table.rows || []).map(function (row) {
        return heads.map(function (_, col) { return plain(row[col] || '—'); });
      });
      if (!body.length) body.push([ 'No matching records in the selected date range.' ].concat(Array(Math.max(0, heads.length - 1)).fill('')));
      const size = heads.length >= 11 ? 6.6 : heads.length >= 9 ? 7 : heads.length >= 7 ? 7.5 : 8.2;
      const durationCols = {};
      heads.forEach(function (heading, i) {
        if (/duration|average|longest|total time|^wait$|time gone/i.test(heading)) {
          durationCols[i] = { minCellWidth: heads.length >= 10 ? 51 : 57 };
        }
      });
      const auto = doc.autoTable ? function (params) { return doc.autoTable(params); }
        : function (params) { return root.jspdfAutoTable.autoTable(doc, params); };
      auto({
        head: [heads], body: body, startY: y,
        columnStyles: durationCols,
        // Continuation pages reserve a row above the repeated column headings.
        margin: { left: PAGE_MARGIN, right: PAGE_MARGIN, top: 96, bottom: 56 },
        theme: 'grid',
        styles: {
          font: font, fontStyle: 'normal', fontSize: size,
          textColor: INK, cellPadding: { top: 5.5, right: 4.6, bottom: 5.5, left: 4.6 },
          valign: 'middle', lineColor: BORDER, lineWidth: .35,
          overflow: 'linebreak', minCellHeight: 22
        },
        headStyles: { fillColor: NAVY, textColor: [255,255,255], fontStyle: 'bold', lineColor: NAVY },
        alternateRowStyles: { fillColor: [247, 250, 254] },
        showHead: 'everyPage',
        rowPageBreak: 'avoid',
        didDrawPage: function (data) {
          drawBanner(doc, width, font, brandMark);
          if (data.pageNumber > 1) {
            doc.setFont(font, 'bold');
            doc.setFontSize(11);
            doc.setTextColor.apply(doc, BLUE);
            doc.text(tableTitle + ' (continued)', PAGE_MARGIN, 77);
          }
        }
      });
      y = ((doc.lastAutoTable || {}).finalY || y) + 28;
    }
    const total = doc.internal.getNumberOfPages();
    for (let page = 1; page <= total; page++) {
      doc.setPage(page);
      drawFooter(doc, page, total, width, height, font, generated);
    }
    const fileName = safeName(options.fileName || title) + '.pdf';
    doc.save(fileName);
    return fileName;
  }

  root.HallPilotReportPdf = {
    exportPdf: exportPdf,
    fromTable: fromTable,
    safeName: safeName
  };
})(window);
