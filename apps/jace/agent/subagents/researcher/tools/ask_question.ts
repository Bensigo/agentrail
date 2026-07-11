import { disableTool } from "eve/tools";

// The researcher is a background specialist, not a conversational agent: it must
// not pause to interrogate the human. Uncertainty is reported in the brief's
// `openQuestions` field and it is ROOT Jace's job to decide what to surface. So
// `ask_question` is disabled — the researcher also needs no approval and never
// interrupts a turn.
export default disableTool();
