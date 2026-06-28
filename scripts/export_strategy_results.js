#!/usr/bin/env node

/**
 * Export TradingView strategy metrics, trades, and equity data to CSV.
 *
 * This script drives the local TradingView Desktop session via the repo's CLI,
 * so it does not depend on Selenium selectors or the TradingView web UI.
 *
 * Requirements:
 * - TradingView Desktop running with --remote-debugging-port=9222
 * - A strategy already added to the chart
 * - TradingView MCP repo checked out locally
 *
 * Usage:
 *   node scripts/export_strategy_results.js NSE:RELIANCE NSE:TCS
 *   node scripts/export_strategy_results.js --symbols-file ..\nifty100_minute\nifty100_symbols__2015-01-01_2026-04-17.csv
 *   node scripts/export_strategy_results.js --timeframe 5 --output-dir exports\strategy
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const cliEntry = join(repoRoot, 'src', 'cli', 'index.js');

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: 'boolean', short: 'h' },
    'symbols-file': { type: 'string' },
    column: { type: 'string' },
    'output-dir': { type: 'string', short: 'o' },
    timeframe: { type: 'string' },
    'delay-ms': { type: 'string' },
    'max-trades': { type: 'string' },
  },
  allowPositionals: true,
  strict: false,
});

if (values.help) {
  printUsage();
  process.exit(0);
}

const outputDir = resolve(repoRoot, values['output-dir'] || join('exports', 'strategy-results'));
const timeframe = values.timeframe || null;
const delayMs = Number(values['delay-ms'] || 2500);
const maxTrades = Number(values['max-trades'] || 500);
const columnName = values.column || 'ticker';

let tickers;
try {
  tickers = collectTickers(positionals, values['symbols-file'], columnName);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

if (tickers.length === 0) {
  printUsage('No tickers were provided.');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

try {
  await preflightConnection();
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const summaryRows = [];
const failures = [];
const originalState = await getOriginalChartState();

try {
  if (timeframe) {
    await runCommand(['timeframe', timeframe]);
  }

  for (let index = 0; index < tickers.length; index += 1) {
    const ticker = tickers[index];
    const safeTicker = sanitizeFileName(ticker);
    const symbolDir = join(outputDir, safeTicker);

    console.log(`[${index + 1}/${tickers.length}] ${ticker}`);

    try {
      await runCommand(['symbol', ticker]);
      await sleep(delayMs);

      const strategy = await runJson(['data', 'strategy']);
      const trades = await runJson(['data', 'trades', '--max', String(maxTrades)]);
      const equity = await runJson(['data', 'equity']);

      mkdirSync(symbolDir, { recursive: true });

      const flattenedStrategy = flattenObject(strategy?.metrics || {});
      const summaryRow = {
        ticker,
        timeframe: timeframe || '',
        strategy_source: strategy?.source || '',
        strategy_error: strategy?.error || '',
        metric_count: strategy?.metric_count ?? 0,
        trade_count: trades?.trade_count ?? 0,
        trade_error: trades?.error || '',
        equity_points: Array.isArray(equity?.data) ? equity.data.length : 0,
        equity_error: equity?.error || '',
        ...flattenedStrategy,
      };

      writeCsv(join(symbolDir, 'strategy_metrics.csv'), [summaryRow]);

      const tradeRows = normalizeRows(trades?.trades || [], {
        ticker,
        includeRowType: 'trade',
      });
      const tradeFallbackRow = {
        ticker,
        includeRowType: 'trade',
        note: trades?.error || 'No trades returned',
        trade_count: trades?.trade_count ?? 0,
      };
      writeCsv(join(symbolDir, 'trades.csv'), tradeRows, tradeFallbackRow);

      const equityRows = normalizeRows(equity?.data || [], {
        ticker,
        includeRowType: 'equity',
      });
      const equityFallbackRow = equity?.equity_summary
        ? {
            ticker,
            includeRowType: 'equity_summary',
            ...flattenObject(equity.equity_summary),
          }
        : {
            ticker,
            includeRowType: 'equity_summary',
            note: equity?.error || 'No equity curve returned',
          };
      writeCsv(join(symbolDir, 'equity.csv'), equityRows, equityFallbackRow);

      summaryRows.push(summaryRow);
      console.log(`  wrote ${safeTicker}/strategy_metrics.csv, trades.csv, equity.csv`);
    } catch (error) {
      failures.push({ ticker, error: error.message });
      summaryRows.push({
        ticker,
        timeframe: timeframe || '',
        strategy_error: error.message,
      });
      console.error(`  failed: ${error.message}`);
    }
  }
} finally {
  try {
    await restoreOriginalChartState(originalState);
  } catch (error) {
    failures.push({ ticker: '__restore__', error: error.message });
    console.error(`Warning: unable to restore the original chart state: ${error.message}`);
  }
}

writeCsv(join(outputDir, 'summary.csv'), summaryRows);

if (failures.length > 0) {
  const failurePath = join(outputDir, 'failures.json');
  writeFileSync(failurePath, `${JSON.stringify(failures, null, 2)}\n`, 'utf8');
  console.log(`\nCompleted with ${failures.length} failure(s). See ${failurePath}`);
  process.exitCode = 1;
} else {
  console.log(`\nCompleted successfully. Output: ${outputDir}`);
}

function printUsage(prefix = '') {
  if (prefix) {
    console.error(prefix);
    console.error('');
  }

  console.error('Usage: node scripts/export_strategy_results.js [options] [TICKER ...]');
  console.error('');
  console.error('Options:');
  console.error('  -h, --help              Show this help');
  console.error('      --symbols-file PATH  Read tickers from a CSV or JSON file');
  console.error('      --column NAME        Column name to read from CSV files (default: ticker)');
  console.error('  -o, --output-dir PATH    Output directory (default: exports/strategy-results)');
  console.error('      --timeframe VALUE    Set the chart timeframe before exporting');
  console.error('      --delay-ms VALUE     Wait after each symbol change (default: 2500)');
  console.error('      --max-trades VALUE   Max trades to export per symbol (default: 500)');
}

function collectTickers(positionalsInput, symbolsFile, column) {
  const explicitTickers = positionalsInput
    .map(value => value.trim())
    .filter(Boolean);

  if (symbolsFile) {
    const filePath = resolve(process.cwd(), symbolsFile);
    const fileTickers = loadTickersFromFile(filePath, column);
    if (explicitTickers.length > 0) {
      return uniqueStrings([...explicitTickers, ...fileTickers]);
    }
    return fileTickers;
  }

  return uniqueStrings(explicitTickers);
}

function loadTickersFromFile(filePath, column) {
  const content = readFileSync(filePath, 'utf8').trim();
  if (!content) {
    return [];
  }

  if (/\.json$/i.test(filePath)) {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return uniqueStrings(parsed.map(value => String(value).trim()));
    }
    if (Array.isArray(parsed.tickers)) {
      return uniqueStrings(parsed.tickers.map(value => String(value).trim()));
    }
    if (Array.isArray(parsed.symbols)) {
      return uniqueStrings(parsed.symbols.map(value => String(value).trim()));
    }
    throw new Error(`JSON file ${filePath} does not contain an array of tickers.`);
  }

  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean).filter(line => !line.startsWith('#'));
  if (lines.length === 0) {
    return [];
  }

  const delimiter = guessDelimiter(lines[0]);
  const firstRowCells = splitRow(lines[0], delimiter).map(value => value.trim());
  const headerLike = firstRowCells.length > 1 || /^(ticker|symbol|name|exchange|instrument)$/i.test(firstRowCells[0] || '');

  if (headerLike) {
    const headerIndex = findHeaderIndex(firstRowCells, column);
    if (headerIndex < 0) {
      throw new Error(`Column "${column}" was not found in ${filePath}. Available columns: ${firstRowCells.join(', ')}`);
    }

    return uniqueStrings(
      lines.slice(1)
        .map(line => splitRow(line, delimiter)[headerIndex])
        .map(value => (value || '').trim())
        .filter(Boolean)
    );
  }

  return uniqueStrings(
    lines.map(line => splitRow(line, delimiter)[0])
      .map(value => (value || '').trim())
      .filter(Boolean)
  );
}

function findHeaderIndex(headers, column) {
  const normalizedTarget = column.trim().toLowerCase();
  return headers.findIndex(header => header.trim().toLowerCase() === normalizedTarget);
}

function guessDelimiter(sample) {
  if (sample.includes('\t')) {
    return '\t';
  }
  if (sample.includes(';') && !sample.includes(',')) {
    return ';';
  }
  return ',';
}

function splitRow(row, delimiter) {
  return row.split(delimiter);
}

async function preflightConnection() {
  const state = await runJson(['status']);
  if (!state?.success) {
    throw new Error(
      'TradingView is not connected. Start TradingView Desktop with CDP enabled first, for example: scripts\\launch_tv_debug.bat 9222'
    );
  }
}

async function runCommand(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout.trim();
  } catch (error) {
    const message = error.stderr?.trim() || error.stdout?.trim() || error.message || 'Unknown CLI error';
    throw new Error(message);
  }
}

async function runJson(args) {
  const output = await runCommand(args);
  if (!output) {
    throw new Error(`Command returned empty output: ${args.join(' ')}`);
  }
  return JSON.parse(output);
}

function normalizeRows(rows, base = {}) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map(row => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return {
        ...base,
        ...flattenObject(row),
      };
    }

    if (Array.isArray(row)) {
      return {
        ...base,
        value: JSON.stringify(row),
      };
    }

    return {
      ...base,
      value: row,
    };
  });
}

function flattenObject(value, prefix = '', target = {}) {
  if (value === null || value === undefined) {
    return target;
  }

  if (Array.isArray(value)) {
    target[prefix || 'value'] = JSON.stringify(value);
    return target;
  }

  if (typeof value !== 'object') {
    target[prefix || 'value'] = value;
    return target;
  }

  for (const [key, nested] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      flattenObject(nested, nextKey, target);
    } else if (Array.isArray(nested)) {
      target[nextKey] = JSON.stringify(nested);
    } else {
      target[nextKey] = nested;
    }
  }

  return target;
}

function writeCsv(filePath, rows, fallbackRow = null) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const effectiveRows = normalizedRows.length > 0
    ? normalizedRows
    : fallbackRow
      ? [fallbackRow]
      : [];
  const headers = collectHeaders(effectiveRows);
  const csv = [headers.map(csvEscape).join(',')]
    .concat(effectiveRows.map(row => headers.map(header => csvEscape(row?.[header])).join(',')))
    .join('\n');

  writeFileSync(filePath, `${csv}\n`, 'utf8');
}

function collectHeaders(rows) {
  const headers = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    for (const key of Object.keys(row)) {
      headers.add(key);
    }
  }
  return [...headers];
}

function csvEscape(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined || text === null) {
    return '';
  }

  const normalized = String(text);
  if (/[",\n\r]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }

  return result;
}

function sanitizeFileName(value) {
  return String(value)
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_');
}

async function getOriginalChartState() {
  try {
    return await runJson(['state']);
  } catch {
    return null;
  }
}

async function restoreOriginalChartState(state) {
  if (!state?.symbol && !state?.resolution) {
    return;
  }

  const errors = [];

  if (state.symbol) {
    try {
      await runCommand(['symbol', state.symbol]);
    } catch (error) {
      errors.push(`symbol=${state.symbol}: ${error.message}`);
    }
  }

  if (state.resolution) {
    try {
      await runCommand(['timeframe', state.resolution]);
    } catch (error) {
      errors.push(`timeframe=${state.resolution}: ${error.message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}