import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SPLIT_FILES = [
  "train.jsonl",
  "dev.jsonl",
  "holdout.jsonl",
  "redteam.jsonl",
  "external.jsonl",
];

function readJsonl(filename) {
  const raw = readFileSync(join(__dirname, filename), "utf-8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

const failures = [];

// Load all records
let allRecords = [];
for (const file of SPLIT_FILES) {
  let records;
  try {
    records = readJsonl(file);
  } catch (err) {
    failures.push(`Failed to read ${file}: ${err.message}`);
    continue;
  }
  allRecords = allRecords.concat(records);
}

// Check for duplicate IDs
const idCounts = new Map();
for (const record of allRecords) {
  idCounts.set(record.id, (idCounts.get(record.id) ?? 0) + 1);
}
for (const [id, count] of idCounts) {
  if (count > 1) {
    failures.push(`Duplicate ID: ${id} appears ${count} times`);
  }
}

// Check no exact text overlap between train and holdout
const trainTexts = new Set(allRecords.filter((r) => r.split === "train").map((r) => r.text));
const holdoutRecords = allRecords.filter((r) => r.split === "holdout");
for (const record of holdoutRecords) {
  if (trainTexts.has(record.text)) {
    failures.push(
      `Text overlap between train and holdout: id=${record.id} text="${record.text.slice(0, 60)}..."`
    );
  }
}

// Check every sample has expected_effect field
for (const record of allRecords) {
  if (!("expected_effect" in record)) {
    failures.push(`Missing expected_effect field: id=${record.id}`);
  }
}

// Check every external sample has source != "internal"
const externalRecords = allRecords.filter((r) => r.split === "external");
for (const record of externalRecords) {
  if (record.source === "internal") {
    failures.push(`External sample has source="internal": id=${record.id}`);
  }
}

// Summary
console.log(`Splits loaded: ${SPLIT_FILES.join(", ")}`);
console.log(`Total records: ${allRecords.length}`);
if (failures.length === 0) {
  console.log("Corpus integrity: OK");
  process.exit(0);
} else {
  console.error(`Corpus integrity: FAILED (${failures.length} issue(s))`);
  for (const msg of failures) {
    console.error(`  - ${msg}`);
  }
  process.exit(1);
}
