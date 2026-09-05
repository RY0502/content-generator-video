/**
 * Structured logging utility for tracking timing and candidate selection
 * throughout the video generation pipeline.
 */

interface TimerEntry {
  name: string;
  startTime: number;
  endTime?: number;
}

const timers = new Map<string, TimerEntry>();
const workflowStartTime = Date.now();

/**
 * Start a named timer for tracking operation duration.
 */
export function startTimer(name: string): void {
  timers.set(name, { name, startTime: Date.now() });
  console.log(`[TIMER] ⏱️  Starting: ${name}`);
}

/**
 * End a named timer and log the duration.
 */
export function endTimer(name: string): number {
  const entry = timers.get(name);
  if (!entry) {
    console.warn(`[TIMER] ⚠️  Timer "${name}" not found`);
    return 0;
  }
  entry.endTime = Date.now();
  const duration = entry.endTime - entry.startTime;
  console.log(`[TIMER] ✓ Completed: ${name} (${duration}ms)`);
  return duration;
}

/**
 * Log a candidate image generation with score and selection status.
 */
export function logCandidate(params: {
  characterName?: string;
  environmentName?: string;
  pose?: string;
  candidateIndex: number;
  totalCandidates: number;
  score: number;
  maxScore: number;
  reason: string;
  isSelected: boolean;
}): void {
  const subject = params.characterName || params.environmentName || "image";
  const poseStr = params.pose ? ` [${params.pose}]` : "";
  const selected = params.isSelected ? "✅ SELECTED" : "❌ rejected";
  const scoreBar = "█".repeat(Math.round(params.score)) + "░".repeat(10 - Math.round(params.score));

  console.log(
    `[CANDIDATE] ${selected} | ${subject}${poseStr} | ` +
      `candidate ${params.candidateIndex + 1}/${params.totalCandidates} | ` +
      `score ${params.score.toFixed(1)}/10 [${scoreBar}] | ${params.reason}`
  );
}

/**
 * Log the finalization of a character/environment sheet.
 */
export function logSheetFinalized(params: {
  type: "character" | "environment";
  name: string;
  poseCount?: number;
  path: string;
}): void {
  const icon = params.type === "character" ? "👤" : "🌳";
  const poseStr = params.poseCount ? ` (${params.poseCount} poses)` : "";
  console.log(`[SHEET] ${icon} ${params.type.toUpperCase()} finalized: ${params.name}${poseStr}`);
  console.log(`        → ${params.path}`);
}

/**
 * Log voice assignment.
 */
export function logVoiceAssigned(params: {
  characterName: string;
  voice: string;
  reason: string;
}): void {
  console.log(`[VOICE] 🎤 ${params.characterName} → ${params.voice} (${params.reason})`);
}

/**
 * Log scene image generation.
 */
export function logSceneGenerated(params: {
  sceneNumber: number;
  characterNames: string[];
  characters: string[];
  environment: string;
  action?: string;
  emotions?: string[];
  poses?: string[];
  movements?: string[];
  objectInteractions?: string;
  path: string;
}): void {
  const charStr = params.characterNames.join(", ");
  console.log(`[SCENE] 🎬 Scene ${params.sceneNumber}: ${charStr} @ ${params.environment}`);
  if (params.action) console.log(`        ACTION: ${params.action}`);
  if (params.emotions?.length) console.log(`        EMOTIONS: ${params.emotions.join("; ")}`);
  if (params.poses?.length) console.log(`        POSES: ${params.poses.join("; ")}`);
  if (params.movements?.length) console.log(`        MOVEMENTS: ${params.movements.join("; ")}`);
  if (params.objectInteractions) console.log(`        INTERACTIONS: ${params.objectInteractions}`);
  console.log(`        → ${params.path}`);
}

/**
 * Log audio synthesis.
 */
export function logAudioSynthesized(params: {
  sceneNumber: number;
  speaker: string;
  duration: number;
  path: string;
}): void {
  console.log(`[AUDIO] 🔊 Scene ${params.sceneNumber}: ${params.speaker} (${params.duration.toFixed(1)}s)`);
  console.log(`        → ${params.path}`);
}

/**
 * Log final video assembly.
 */
export function logVideoAssembled(params: {
  episodeNumber: number;
  sceneCount: number;
  totalDuration: number;
  path: string;
}): void {
  console.log(`[VIDEO] 🎥 Episode ${params.episodeNumber} assembled (${params.sceneCount} scenes, ${params.totalDuration.toFixed(1)}s)`);
  console.log(`        → ${params.path}`);
}

/**
 * Log workflow completion with total duration.
 */
export function logWorkflowComplete(params: {
  seriesName: string;
  episodeNumber: number;
  success: boolean;
}): void {
  const totalTime = Date.now() - workflowStartTime;
  const minutes = Math.floor(totalTime / 60000);
  const seconds = ((totalTime % 60000) / 1000).toFixed(1);
  const icon = params.success ? "✅" : "❌";

  console.log("\n" + "=".repeat(80));
  console.log(`${icon} WORKFLOW COMPLETE: ${params.seriesName} Episode ${params.episodeNumber}`);
  console.log(`   Total time: ${minutes}m ${seconds}s`);
  console.log("=".repeat(80) + "\n");
}

/**
 * Log an error with context.
 */
export function logError(params: {
  context: string;
  message: string;
  details?: string;
}): void {
  console.error(`[ERROR] ❌ ${params.context}: ${params.message}`);
  if (params.details) {
    console.error(`        ${params.details}`);
  }
}

/**
 * Log a step in the pipeline.
 */
export function logStep(message: string): void {
  console.log(`[STEP] 📍 ${message}`);
}

/**
 * Get all timers for summary reporting.
 */
export function getTimerSummary(): Array<{ name: string; duration: number }> {
  return Array.from(timers.values())
    .filter((t) => t.endTime !== undefined)
    .map((t) => ({ name: t.name, duration: t.endTime! - t.startTime }))
    .sort((a, b) => b.duration - a.duration);
}

/**
 * Log a timing summary.
 */
export function logTimingSummary(): void {
  const summary = getTimerSummary();
  if (summary.length === 0) return;

  console.log("\n" + "=".repeat(80));
  console.log("⏱️  TIMING SUMMARY (sorted by duration)");
  console.log("=".repeat(80));

  const totalDuration = summary.reduce((sum, t) => sum + t.duration, 0);
  for (const timer of summary) {
    const percent = ((timer.duration / totalDuration) * 100).toFixed(1);
    const bar = "█".repeat(Math.round((timer.duration / Math.max(...summary.map((t) => t.duration))) * 30));
    console.log(`  ${timer.name.padEnd(40)} ${timer.duration.toString().padStart(6)}ms (${percent.padStart(5)}%) ${bar}`);
  }

  console.log(`  ${"TOTAL".padEnd(40)} ${totalDuration.toString().padStart(6)}ms`);
  console.log("=".repeat(80) + "\n");
}
