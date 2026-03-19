// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Policy preset management — list, load, merge, and apply presets.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ROOT, run, runCapture } = require("./runner");
const registry = require("./registry");

const PRESETS_DIR = path.join(ROOT, "nemoclaw-blueprint", "policies", "presets");

function listPresets() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs
    .readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => {
      const content = fs.readFileSync(path.join(PRESETS_DIR, f), "utf-8");
      const nameMatch = content.match(/^\s*name:\s*(.+)$/m);
      const descMatch = content.match(/^\s*description:\s*"?([^"]*)"?$/m);
      return {
        file: f,
        name: nameMatch ? nameMatch[1].trim() : f.replace(".yaml", ""),
        description: descMatch ? descMatch[1].trim() : "",
      };
    });
}

function loadPreset(name) {
  const file = path.join(PRESETS_DIR, `${name}.yaml`);
  if (!fs.existsSync(file)) {
    console.error(`  Preset not found: ${name}`);
    return null;
  }
  return fs.readFileSync(file, "utf-8");
}

function getPresetEndpoints(content) {
  const hosts = [];
  const regex = /host:\s*([^\s,}]+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    hosts.push(match[1]);
  }
  return hosts;
}

/**
 * Extract just the network_policies entries (indented content under
 * the `network_policies:` key) from a preset file, stripping the
 * `preset:` metadata header.
 */
function extractPresetEntries(presetContent) {
  const npMatch = presetContent.match(/^network_policies:\n([\s\S]*)$/m);
  if (!npMatch) return null;
  return npMatch[1].trimEnd();
}

/**
 * Parse the output of `openshell policy get --full` which has a metadata
 * header (Version, Hash, etc.) followed by `---` and then the actual YAML.
 */
function parseCurrentPolicy(raw) {
  if (!raw) return "";
  const sep = raw.indexOf("---");
  if (sep === -1) return raw;
  return raw.slice(sep + 3).trim();
}

/**
 * Build the openshell policy set command with properly quoted arguments.
 */
function buildPolicySetCommand(policyFile, sandboxName) {
  return `openshell policy set --policy "${policyFile}" --wait "${sandboxName}"`;
}

/**
 * Build the openshell policy get command with properly quoted arguments.
 */
function buildPolicyGetCommand(sandboxName) {
  return `openshell policy get --full "${sandboxName}" 2>/dev/null`;
}

function applyPreset(sandboxName, presetName, vars) {
  let presetContent = loadPreset(presetName);
  if (!presetContent) {
    console.error(`  Cannot load preset: ${presetName}`);
    return false;
  }

  // Substitute variables (e.g. { host: "ai1.lab" } replaces `host: localhost`)
  if (vars && vars.host) {
    presetContent = presetContent.replace(
      /(\bhost:\s*)localhost\b/g,
      `$1${vars.host}`
    );
  }

  const presetEntries = extractPresetEntries(presetContent);
  if (!presetEntries) {
    console.error(`  Preset ${presetName} has no network_policies section.`);
    return false;
  }

  // Get current policy YAML from sandbox
  let rawPolicy = "";
  try {
    rawPolicy = runCapture(
      buildPolicyGetCommand(sandboxName),
      { ignoreError: true }
    );
  } catch {}

  let currentPolicy = parseCurrentPolicy(rawPolicy);

  // Merge: inject preset entries under the existing network_policies key
  let merged;
  if (currentPolicy && currentPolicy.includes("network_policies:")) {
    // Find the network_policies: line and append the new entries after it
    // We need to insert before the next top-level key or end of file
    const lines = currentPolicy.split("\n");
    const result = [];
    let inNetworkPolicies = false;
    let inserted = false;

    for (const line of lines) {
      // Detect top-level keys (no leading whitespace, ends with colon)
      const isTopLevel = /^\S.*:/.test(line);

      if (line.trim() === "network_policies:" || line.trim().startsWith("network_policies:")) {
        inNetworkPolicies = true;
        result.push(line);
        continue;
      }

      if (inNetworkPolicies && isTopLevel && !inserted) {
        // We hit the next top-level key — insert preset entries before it
        result.push(presetEntries);
        inserted = true;
        inNetworkPolicies = false;
      }

      result.push(line);
    }

    // If network_policies was the last section, append at end
    if (inNetworkPolicies && !inserted) {
      result.push(presetEntries);
    }

    merged = result.join("\n");
  } else if (currentPolicy) {
    // No network_policies section yet — append one
    // Ensure version field exists
    if (!currentPolicy.includes("version:")) {
      currentPolicy = "version: 1\n" + currentPolicy;
    }
    merged = currentPolicy + "\n\nnetwork_policies:\n" + presetEntries;
  } else {
    // No current policy at all
    merged = "version: 1\n\nnetwork_policies:\n" + presetEntries;
  }

  // Write temp file and apply
  const tmpFile = path.join(os.tmpdir(), `nemoclaw-policy-${Date.now()}.yaml`);
  fs.writeFileSync(tmpFile, merged, "utf-8");

  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));

    console.log(`  Applied preset: ${presetName}`);
  } finally {
    fs.unlinkSync(tmpFile);
  }

  // Update registry
  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const pols = sandbox.policies || [];
    if (!pols.includes(presetName)) {
      pols.push(presetName);
    }
    registry.updateSandbox(sandboxName, { policies: pols });
  }

  return true;
}

/**
 * Apply multiple presets atomically: one GET, all merges in memory, one SET.
 * Avoids the race where a subsequent GET misses a just-applied preset.
 *
 * @param {string} sandboxName
 * @param {Array<{name: string, vars?: object}>} presets
 */
function applyPresets(sandboxName, presets) {
  // Load and validate all preset entries first
  const entries = [];
  for (const { name, vars } of presets) {
    let content = loadPreset(name);
    if (!content) {
      console.error(`  Cannot load preset: ${name}`);
      return false;
    }
    if (vars && vars.host) {
      content = content.replace(/(\bhost:\s*)localhost\b/g, `$1${vars.host}`);
    }
    const extracted = extractPresetEntries(content);
    if (!extracted) {
      console.error(`  Preset ${name} has no network_policies section.`);
      return false;
    }
    entries.push({ name, extracted });
  }

  // GET once
  let rawPolicy = "";
  try {
    rawPolicy = runCapture(buildPolicyGetCommand(sandboxName), { ignoreError: true });
  } catch {}
  let currentPolicy = parseCurrentPolicy(rawPolicy);

  // Merge all entries in sequence into the same base policy
  let merged = currentPolicy;
  for (const { extracted: presetEntries } of entries) {
    if (merged && merged.includes("network_policies:")) {
      const lines = merged.split("\n");
      const result = [];
      let inNetworkPolicies = false;
      let inserted = false;

      for (const line of lines) {
        const isTopLevel = /^\S.*:/.test(line);
        if (line.trim() === "network_policies:" || line.trim().startsWith("network_policies:")) {
          inNetworkPolicies = true;
          result.push(line);
          continue;
        }
        if (inNetworkPolicies && isTopLevel && !inserted) {
          result.push(presetEntries);
          inserted = true;
          inNetworkPolicies = false;
        }
        result.push(line);
      }
      if (inNetworkPolicies && !inserted) {
        result.push(presetEntries);
      }
      merged = result.join("\n");
    } else if (merged) {
      if (!merged.includes("version:")) {
        merged = "version: 1\n" + merged;
      }
      merged = merged + "\n\nnetwork_policies:\n" + presetEntries;
    } else {
      merged = "version: 1\n\nnetwork_policies:\n" + presetEntries;
    }
  }

  // SET once
  const tmpFile = path.join(os.tmpdir(), `nemoclaw-policy-${Date.now()}.yaml`);
  fs.writeFileSync(tmpFile, merged, "utf-8");
  try {
    run(buildPolicySetCommand(tmpFile, sandboxName));
    console.log(`  Applied presets: ${presets.map((p) => p.name).join(", ")}`);
  } finally {
    fs.unlinkSync(tmpFile);
  }

  // Update registry
  const sandbox = registry.getSandbox(sandboxName);
  if (sandbox) {
    const existing = sandbox.policies || [];
    for (const { name } of presets) {
      if (!existing.includes(name)) existing.push(name);
    }
    registry.updateSandbox(sandboxName, { policies: existing });
  }

  return true;
}

function getAppliedPresets(sandboxName) {
  const sandbox = registry.getSandbox(sandboxName);
  return sandbox ? sandbox.policies || [] : [];
}

module.exports = {
  PRESETS_DIR,
  listPresets,
  loadPreset,
  getPresetEndpoints,
  extractPresetEntries,
  parseCurrentPolicy,
  buildPolicySetCommand,
  buildPolicyGetCommand,
  applyPreset,
  applyPresets,
  getAppliedPresets,
};
