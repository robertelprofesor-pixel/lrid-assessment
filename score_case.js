const fs = require("fs");
const path = require("path");
const { runScoring } = require("./scoring_engine");

function readJson(p){ return JSON.parse(fs.readFileSync(p,"utf8")); }
function writeJson(p,o){ fs.writeFileSync(p, JSON.stringify(o,null,2),"utf8"); }

function main(){
  const input = process.argv[2];
  if(!input){
    console.error("Usage: node score_case.js data/responses_<case_id>.json");
    process.exit(1);
  }

  const root = __dirname;
  const responsesPath = path.isAbsolute(input) ? input : path.join(root, input);
  const responses = readJson(responsesPath);
  const caseId = responses?.meta?.case_id;

  const outDir = path.join(root, "data");
  if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const result = runScoring({ responsesPath });
  const outPath = path.join(outDir, `score_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));

  writeJson(outPath, { meta: responses.meta, ...result });
  console.log("✔ Saved:", path.relative(root, outPath));
}

main();
