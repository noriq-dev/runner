import { readFileSync } from 'node:fs';

/**
 * Prompt templates live as markdown files under prompts/ — one file per voice — so the words
 * an agent is handed can be maintained (reviewed, diffed, tuned) without touching assembly
 * code. The code keeps what code is good at: which template fires, and with which facts.
 *
 * Templates use a deliberately tiny mustache subset — three forms, no nesting, no escaping:
 *   {{name}}            interpolate (null renders as '', a MISSING key throws)
 *   {{#name}}…{{/name}} keep the body iff the value is truthy (not null/false/'')
 *   {{^name}}…{{/name}} keep the body iff it is not
 * Rendering is literal text substitution — no whitespace magic around section tags, so the
 * template file shows exactly what the agent will read. Section tags sit INSIDE lines for
 * exactly that reason: a conditional sentence carries its own leading newline.
 *
 * A missing variable or unknown template throws rather than rendering a hole: every template
 * name and variable set is compile-time-known at its single call site, so a throw here is a
 * programming error the test suite catches — never a runtime judgment call.
 */
export type PromptVars = Record<string, string | number | boolean | null>;

const SECTION_RE = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const VAR_RE = /\{\{(\w+)\}\}/g;

/** '' is falsy on purpose: callers pass `manifest.verify?.cmd ?? null`-shaped values, and an
 *  empty command must not switch a sentence on. */
const truthy = (v: PromptVars[string]) => v !== null && v !== false && v !== '';

export function renderTemplate(template: string, vars: PromptVars): string {
  const sectioned = template.replace(SECTION_RE, (_, mode: string, name: string, body: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt section {{${mode}${name}}} has no variable`);
    return (mode === '#' ? truthy(v) : !truthy(v)) ? body : '';
  });
  return sectioned.replace(VAR_RE, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`prompt variable {{${name}}} was not provided`);
    return v === null ? '' : String(v);
  });
}

/**
 * Injected at build time by esbuild's `define` (same pattern as __RUNNER_VERSION__ in
 * version.ts): the bundle carries every template inline, so dist/cli.js stays the one
 * self-contained file the package ships. The dev path (tsx/vitest, no define) reads
 * prompts/*.md from disk instead — edit a template, rerun, no build step.
 */
declare const __RUNNER_PROMPTS__: Record<string, string>;

const cache = new Map<string, string>();

/** The raw template. trimEnd matches the build-time injection: files end with a newline
 *  (editors insist), prompts must not. */
export function promptTemplate(name: string): string {
  let t = cache.get(name);
  if (t === undefined) {
    if (typeof __RUNNER_PROMPTS__ !== 'undefined') {
      const bundled = __RUNNER_PROMPTS__[name];
      if (bundled === undefined) throw new Error(`unknown prompt template '${name}'`);
      t = bundled;
    } else {
      t = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8').trimEnd();
    }
    cache.set(name, t);
  }
  return t;
}

/** Render prompts/<name>.md with the given variables. */
export function renderPrompt(name: string, vars: PromptVars = {}): string {
  return renderTemplate(promptTemplate(name), vars);
}
