import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const files = {
  May: "/Users/a81178043/Downloads/sessions_may.csv",
  June: "/Users/a81178043/Downloads/sessions_june.csv",
  July: "/Users/a81178043/Downloads/sessions_july.csv",
  Users: "/Users/a81178043/Downloads/users.csv",
};

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const headers = lines[0].match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)
    .map(v => v.replace(/^,/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  return lines.slice(1).filter(Boolean).map(line => {
    const fields = line.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)
      .map(v => v.replace(/^,/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
    return Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ""]));
  });
}

const raw = {};
for (const [name, path] of Object.entries(files)) {
  raw[name] = parseCsv(await fs.readFile(path, "utf8"));
}

const normalize = value => String(value ?? "").trim().toLowerCase();
const users = [];
const seenUsers = new Set();
for (const row of raw.Users) {
  const email = normalize(row.Email);
  if (email.includes("@") && !seenUsers.has(email)) {
    users.push(email);
    seenUsers.add(email);
  }
}

const monthSets = Object.fromEntries(["May", "June", "July"].map(month => [
  month,
  new Set(raw[month].map(row => normalize(row.Email)).filter(email => email.includes("@"))),
]));

const matrix = users.map(email => [
  email,
  monthSets.May.has(email) ? "Yes" : "No",
  monthSets.June.has(email) ? "Yes" : "No",
  monthSets.July.has(email) ? "Yes" : "No",
]);

const workbook = Workbook.create();
const sheet = workbook.worksheets.add("Login Activity");
sheet.showGridLines = false;
sheet.tabColor = "#1F4E78";

sheet.getRange("A2:D2").values = [["Monthly User Login Activity", null, null, null]];
sheet.getRange("A2:D2").format.font = { name: "Arial", size: 14, bold: true, color: "#1F2937" };
sheet.getRange("A3:D3").format.borders = { bottom: { style: "thin", color: "#9CA3AF" } };

const tableStart = 5;
const tableEnd = tableStart + matrix.length;
sheet.getRange(`A${tableStart}:D${tableEnd}`).values = [
  ["Email", "May", "June", "July"],
  ...matrix,
];

const header = sheet.getRange(`A${tableStart}:D${tableStart}`);
header.format = {
  fill: "#1F4E78",
  font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  borders: { insideVertical: { style: "thin", color: "#FFFFFF" } },
};

const body = sheet.getRange(`A${tableStart + 1}:D${tableEnd}`);
body.format.font = { name: "Arial", size: 10, color: "#1F2937" };
body.format.verticalAlignment = "center";
sheet.getRange(`A${tableStart + 1}:A${tableEnd}`).format.horizontalAlignment = "left";
sheet.getRange(`B${tableStart + 1}:D${tableEnd}`).format.horizontalAlignment = "center";
sheet.getRange(`A${tableStart}:D${tableEnd}`).format.borders = {
  insideHorizontal: { style: "thin", color: "#E5E7EB" },
  bottom: { style: "thin", color: "#9CA3AF" },
};

const statusRange = sheet.getRange(`B${tableStart + 1}:D${tableEnd}`);
statusRange.conditionalFormats.add("containsText", {
  text: "Yes",
  format: { fill: "#DCFCE7", font: { color: "#166534", bold: true } },
});
statusRange.conditionalFormats.add("containsText", {
  text: "No",
  format: { fill: "#F3F4F6", font: { color: "#6B7280" } },
});

sheet.getRange(`A${tableStart}:A${tableEnd}`).format.columnWidth = 48;
sheet.getRange(`B${tableStart}:D${tableEnd}`).format.columnWidth = 13;
header.format.rowHeight = 24;
body.format.rowHeight = 20;
sheet.freezePanes.freezeRows(tableStart);

const table = sheet.tables.add(`A${tableStart}:D${tableEnd}`, true, "UserLoginActivity");
table.style = "TableStyleMedium2";
table.showBandedColumns = false;
table.showFilterButton = true;

workbook.recalculate();

const inspect = await workbook.inspect({
  kind: "table",
  range: `Login Activity!A${tableStart}:D${Math.min(tableEnd, tableStart + 8)}`,
  include: "values,formulas",
  tableMaxRows: 10,
  tableMaxCols: 4,
});
console.log(inspect.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const outputDir = "/Users/a81178043/Downloads/content-generator-master/outputs/user_login_activity_regenerated_20260915";
await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({ sheetName: "Login Activity", range: `A1:D${tableEnd}`, scale: 1, format: "png" });
await fs.writeFile(`${outputDir}/preview.png`, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(`${outputDir}/user_login_activity_may_july_regenerated.xlsx`);

console.log(JSON.stringify({
  output: `${outputDir}/user_login_activity_may_july_regenerated.xlsx`,
  preview: `${outputDir}/preview.png`,
  users: users.length,
  matched: Object.fromEntries(Object.entries(monthSets).map(([month, set]) => [month, users.filter(email => set.has(email)).length])),
  sourceUnique: Object.fromEntries(Object.entries(monthSets).map(([month, set]) => [month, set.size])),
  outsideRoster: Object.fromEntries(Object.entries(monthSets).map(([month, set]) => [month, [...set].filter(email => !seenUsers.has(email)).length])),
}, null, 2));
