// Prompts for steps A and B. `two-call` is the pipeline's own pair (extract.ts EXTRACT_PROMPT, then LABEL_PROMPT over
// the extracted records and the same notes). `one-call` asks the label fields inside the extraction call, so the notes
// are read once. The one-call prompt lives in the pipeline (extract.ts, `UNSTALE_EXTRACT_STRUCTURE=one-call`),
// assembled there from the two prompts at load time.
export { ONE_CALL_PROMPT, type ExtractStructure as Structure } from "../../central/src/pipeline/extract.ts";
