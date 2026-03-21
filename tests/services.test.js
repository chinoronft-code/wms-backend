/**
 * Tests — Packing Service & Request Service core logic
 */

const { assignSkuToPackers, parseImportFile } = require('../src/services/request/requestService');

// ─── assignSkuToPackers ───────────────────────────────────────────────────────
describe('assignSkuToPackers', () => {
  const makeSku = (n) => Array.from({ length: n }, (_, i) => ({
    skuCode: `SKU-${String(i + 1).padStart(5, '0')}`,
    skuName: `Product ${i + 1}`,
    barcode: `BC${i + 1}`,
    quantity: 1,
  }));

  test('distributes 1000 SKUs across 5 packers — 200 each', () => {
    const items   = makeSku(1000);
    const packers = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const result  = assignSkuToPackers(items, packers);

    expect(result).toHaveLength(1000);
    packers.forEach((pid) => {
      const mine = result.filter((r) => r.assignedTo === pid);
      expect(mine).toHaveLength(200);
    });
  });

  test('overflow SKUs go to last packer', () => {
    const items   = makeSku(210);
    const packers = ['p1'];
    const result  = assignSkuToPackers(items, packers);

    expect(result).toHaveLength(210);
    expect(result.every((r) => r.assignedTo === 'p1')).toBe(true);
  });

  test('throws when no packers provided', () => {
    expect(() => assignSkuToPackers(makeSku(10), [])).toThrow('No active packers');
  });

  test('handles uneven split (1000 SKUs, 3 packers)', () => {
    const items   = makeSku(1000);
    const packers = ['p1', 'p2', 'p3'];
    const result  = assignSkuToPackers(items, packers);

    expect(result).toHaveLength(1000);
    // p1=200, p2=200, p3=600 (overflow to last)
    expect(result.filter((r) => r.assignedTo === 'p1')).toHaveLength(200);
    expect(result.filter((r) => r.assignedTo === 'p2')).toHaveLength(200);
    expect(result.filter((r) => r.assignedTo === 'p3')).toHaveLength(600);
  });
});

// ─── parseImportFile ──────────────────────────────────────────────────────────
const XLSX = require('xlsx');

const makeExcelBuffer = (rows) => {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

describe('parseImportFile', () => {
  test('parses valid Excel rows', () => {
    const buf = makeExcelBuffer([
      { 'SKU Code': 'SKU-001', 'SKU Name': 'Widget A', Barcode: 'BC001', Quantity: 5 },
      { 'SKU Code': 'SKU-002', 'SKU Name': 'Widget B', Barcode: 'BC002', Quantity: 3 },
    ]);
    const { items, errors } = parseImportFile(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(errors).toHaveLength(0);
    expect(items).toHaveLength(2);
    expect(items[0].skuCode).toBe('SKU-001');
    expect(items[0].quantity).toBe(5);
  });

  test('reports missing SKU Code as error', () => {
    const buf = makeExcelBuffer([
      { 'SKU Name': 'Widget A', Barcode: 'BC001', Quantity: 1 },
    ]);
    const { items, errors } = parseImportFile(buf, 'application/xlsx');
    expect(items).toHaveLength(0);
    expect(errors[0]).toMatch(/missing SKU Code/);
  });

  test('reports invalid quantity', () => {
    const buf = makeExcelBuffer([
      { 'SKU Code': 'SKU-001', 'SKU Name': 'Widget A', Quantity: -1 },
    ]);
    const { errors } = parseImportFile(buf);
    expect(errors[0]).toMatch(/invalid Quantity/);
  });
});
