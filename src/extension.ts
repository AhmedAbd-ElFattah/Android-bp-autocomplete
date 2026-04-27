import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface KeyDef {
  key: string;
  type: string;
  description: string;
}

// Maps module type names (e.g. "cc_binary") to their property definitions.
type SoongData = Record<string, KeyDef[]>;

/**
 * Classify a type string into one of three snippet kinds so we can emit the
 * right VSCode snippet placeholder for each property.
 *
 *   LIST   → key: ["$N"],
 *     covers: "list of string", "list of *ast.SelectorExpr", "interface", etc.
 *
 *   BOOL   → key: ${N|true,false|},
 *     covers: "bool", "configurable bool"
 *
 *   SCALAR → key: "$N",
 *     covers: "string", "configurable string", "int64",
 *             "ConfigVarProperties", "FuzzConfig", and similar named types
 */
type SnippetKind = 'list' | 'bool' | 'scalar';

function snippetKind(type: string): SnippetKind {
  if (
    type.startsWith('list of') ||
    type.startsWith('configurable list') ||
    type === 'interface'
  ) {
    return 'list';
  }
  if (type === 'bool' || type === 'configurable bool') {
    return 'bool';
  }
  return 'scalar';
}

// ─── Data loading ─────────────────────────────────────────────────────────────

/**
 * Loads soong_schema.json from the extension directory at runtime.
 *
 * The file is NOT compiled into the JS bundle — it is read from disk each time
 * the extension activates. This means the JSON can be swapped for a newer version
 * without recompiling any TypeScript.
 *
 * Returns an empty object (and shows an error notification) if the file is
 * missing or malformed, so the rest of the extension degrades gracefully.
 */
function loadSoongData(context: vscode.ExtensionContext): SoongData {
  const jsonPath = path.join(context.extensionPath, 'soong_schema.json');
  try {
    const raw  = fs.readFileSync(jsonPath, 'utf-8');
    const data = JSON.parse(raw) as SoongData;
    return data;
  } catch (e) {
    vscode.window.showErrorMessage(
      `Android.bp Autocomplete: Failed to load soong_schema.json — ${e}\nExpected at: ${jsonPath}`
    );
    return {};
  }
}

// ─── Snippet builder ──────────────────────────────────────────────────────────

/**
 * Builds a VSCode snippet string for a complete module block.
 *
 * Each key gets a numbered tabstop. Tab cycles through every property in the
 * order they were selected in the quick-pick (name always first).
 *
 *   list   → key: ["${N}"],
 *   bool   → key: ${N|true,false|},
 *   scalar → key: "${N}",
 */
function buildSnippet(nodeName: string, keys: KeyDef[]): string {
  let tab = 1;
  const lines: string[] = [`${nodeName} {`];
  for (const k of keys) {
    switch (snippetKind(k.type)) {
      case 'list':
        lines.push(`    ${k.key}: ["\${${tab++}}"],`);
        break;
      case 'bool':
        lines.push(`    ${k.key}: \${${tab++}|true,false|},`);
        break;
      case 'scalar':
        lines.push(`    ${k.key}: "\${${tab++}}",`);
        break;
    }
  }
  lines.push('}');
  return lines.join('\n');
}

// ─── Document helpers ─────────────────────────────────────────────────────────

/**
 * Returns the brace-nesting depth at the given cursor position.
 *
 *   0  = top-level (outside any block) → offer module type completions
 *   1  = inside a module block         → offer property key completions
 *   2+ = nested block (e.g. arch { x86 { } })
 *
 * We count every character up to the cursor rather than using a per-line regex
 * so that multi-line strings and deeply nested blocks are handled correctly.
 */
function getBraceDepth(document: vscode.TextDocument, position: vscode.Position): number {
  let depth = 0;
  for (let line = 0; line <= position.line; line++) {
    const text =
      line === position.line
        ? document.lineAt(line).text.slice(0, position.character)
        : document.lineAt(line).text;
    for (const ch of text) {
      if (ch === '{')      { depth++; }
      else if (ch === '}') { depth = Math.max(0, depth - 1); }
    }
  }
  return depth;
}

/**
 * Scans backwards from the cursor to find the enclosing module type name.
 *
 * Example — cursor on the blank line inside:
 *   cc_binary {
 *       <cursor>
 * → returns "cc_binary"
 *
 * The algorithm walks backwards character-by-character. It tracks unmatched
 * closing braces (braceCount). When it finds an opening '{' with braceCount === 0,
 * it grabs the identifier immediately before it. Returns undefined if no module
 * name can be determined (e.g. inside an anonymous block).
 */
function getEnclosingNodeName(
  document: vscode.TextDocument,
  position: vscode.Position
): string | undefined {
  let braceCount = 0;
  for (let line = position.line; line >= 0; line--) {
    const text =
      line === position.line
        ? document.lineAt(line).text.slice(0, position.character)
        : document.lineAt(line).text;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === '}') {
        braceCount++;
      } else if (text[i] === '{') {
        if (braceCount === 0) {
          // This '{' is our enclosing block opener — grab the identifier before it.
          const before = text.slice(0, i).trimEnd();
          const match  = before.match(/([a-zA-Z_][a-zA-Z0-9_]*)$/);
          return match ? match[1] : undefined;
        }
        braceCount--;
      }
    }
  }
  return undefined;
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

/**
 * Deduplicates a KeyDef array by key name, preserving the first occurrence.
 *
 * Some module types in soong_schema.json inherit properties from parent types and
 * list them more than once. This ensures each property appears exactly once in
 * completions and the quick-pick.
 */
function dedupeKeys(keys: KeyDef[]): KeyDef[] {
  const seen = new Set<string>();
  return keys.filter(k => {
    if (seen.has(k.key)) { return false; }
    seen.add(k.key);
    return true;
  });
}

/**
 * Builds a union of every unique key across all modules, sorted alphabetically.
 *
 * Used as the fallback suggestion list when the enclosing module type cannot be
 * determined (e.g. inside an anonymous or unrecognised block). The first KeyDef
 * seen for each key name is kept so that type information is not lost.
 */
function buildAllKeys(data: SoongData): KeyDef[] {
  const map = new Map<string, KeyDef>();
  for (const keys of Object.values(data)) {
    for (const k of keys) {
      if (!map.has(k.key)) {
        map.set(k.key, k);
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Returns the first line of a description, capped at maxLen characters.
 * Keeps completion-item labels readable without truncating mid-word messily.
 */
function shortDesc(description: string, maxLen = 90): string {
  const first = description.split('\n')[0].trim();
  return first.length > maxLen ? first.slice(0, maxLen - 1) + '…' : first;
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const data      = loadSoongData(context);
  const nodeNames = Object.keys(data).sort();
  // Pre-build the cross-module key union once at activation; it does not change
  // at runtime because soong_schema.json is only read once.
  const allKeys   = buildAllKeys(data);

  // ── 1. Completion provider ──────────────────────────────────────────────────
  //
  // Two contexts:
  //   a) depth === 0  → top-level: suggest module type names.
  //                     Accepting a name triggers the quick-pick command.
  //   b) depth >= 1   → inside a block: suggest property keys.
  //                     Module-specific keys appear first, global keys after.
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: 'android-bp', scheme: 'file' },
    {
      provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): vscode.CompletionItem[] {
        const depth      = getBraceDepth(document, position);
        const linePrefix = document.lineAt(position).text
          .slice(0, position.character)
          .trimStart();

        // ── Top-level: offer module type names ────────────────────────────────
        if (depth === 0) {
          return nodeNames.map(name => {
            const keys = data[name] ?? [];
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
            item.detail = `Android.bp module  (${keys.length} properties)`;

            // Preview the first 8 properties so the developer can quickly
            // confirm they have the right module type before accepting.
            const preview = keys
              .slice(0, 8)
              .map(k => `- \`${k.key}\` *(${k.type})*${k.description ? ' — ' + shortDesc(k.description, 60) : ''}`)
              .join('\n');
            item.documentation = new vscode.MarkdownString(
              `**${name}**\n\n${preview}${keys.length > 8 ? `\n- … *(${keys.length - 8} more)*` : ''}`
            );

            // Insert nothing directly; the command opens the property picker
            // which then writes the full snippet.
            item.insertText = '';
            item.command = {
              command:   'android-bp.pickKeys',
              title:     'Pick properties',
              arguments: [name],
            };
            item.sortText = '0' + name;
            return item;
          });
        }

        // ── Inside a block: offer property keys ───────────────────────────────
        // Only fire before any ':' on the line — after a colon the user is
        // editing the value side and we have nothing meaningful to suggest.
        if (!linePrefix.includes(':')) {
          const nodeName   = getEnclosingNodeName(document, position);
          const nodeKeys   = nodeName ? (data[nodeName] ?? allKeys) : allKeys;
          const deduped    = dedupeKeys(nodeKeys);
          const nodeKeySet = new Set(deduped.map(k => k.key));

          // Module-specific keys come first, in their soong_schema.json order.
          const nodeItems: vscode.CompletionItem[] = deduped.map((k, i) => {
            const item = new vscode.CompletionItem(k.key, vscode.CompletionItemKind.Property);
            item.detail       = k.description ? shortDesc(k.description) : k.type;
            item.documentation = new vscode.MarkdownString(
              `**${k.key}** *(${k.type})*${k.description ? '\n\n' + k.description : ''}`
            );
            item.sortText = String(i).padStart(5, '0');
            return item;
          });

          // All remaining global keys come last, alphabetically, as an escape
          // hatch for shared or unusual properties.
          const restItems: vscode.CompletionItem[] = allKeys
            .filter(k => !nodeKeySet.has(k.key))
            .map((k, i) => {
              const item = new vscode.CompletionItem(k.key, vscode.CompletionItemKind.Property);
              item.detail        = k.type;
              item.documentation = k.description
                ? new vscode.MarkdownString(`**${k.key}** *(${k.type})*\n\n${k.description}`)
                : undefined;
              item.sortText = '99999' + String(i).padStart(5, '0');
              return item;
            });

          return [...nodeItems, ...restItems];
        }

        return [];
      },
    }
  );

  // ── 2. Quick-pick command ───────────────────────────────────────────────────
  //
  // Opened after a module type name is accepted at the top level.
  // Lets the developer choose exactly which properties to scaffold.
  // "name" is pre-checked because every Soong module requires it.
  // Cancelling or confirming with nothing selected inserts a minimal bare block.
  const pickKeysCommand = vscode.commands.registerCommand(
    'android-bp.pickKeys',
    async (nodeName: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }

      const keys = dedupeKeys(data[nodeName] ?? []);
      if (keys.length === 0) {
        // Module not in soong_schema.json — insert a bare block so the user is
        // not left with nothing.
        editor.insertSnippet(
          new vscode.SnippetString(`${nodeName} {\n    name: "$1",\n    $0\n}`)
        );
        return;
      }

      const qpItems: vscode.QuickPickItem[] = keys.map(k => ({
        label:       k.key,
        description: k.type,
        detail:      k.description ? shortDesc(k.description, 120) : undefined,
        // Pre-check "name" — it is mandatory for every module type.
        picked:      k.key === 'name',
      }));

      const selected = await vscode.window.showQuickPick(qpItems, {
        canPickMany:        true,
        placeHolder:        `Select properties for ${nodeName} { }`,
        title:              `${nodeName}  —  ${keys.length} properties available  (Space = toggle, Enter = confirm)`,
        matchOnDescription: true,
        matchOnDetail:      true,
      });

      if (!selected || selected.length === 0) {
        editor.insertSnippet(
          new vscode.SnippetString(`${nodeName} {\n    name: "$1",\n    $0\n}`)
        );
        return;
      }

      // Always put "name" first regardless of how the user ordered their picks,
      // then keep soong_schema.json order for the remaining properties.
      const keyMap     = new Map(keys.map(k => [k.key, k]));
      const nameFirst  = selected.filter(i => i.label === 'name');
      const rest       = selected.filter(i => i.label !== 'name');
      const chosenDefs = [...nameFirst, ...rest].map(
        i => keyMap.get(i.label) ?? { key: i.label, type: 'string', description: '' }
      );

      editor.insertSnippet(new vscode.SnippetString(buildSnippet(nodeName, chosenDefs)));
    }
  );

  // ── 3. Hover provider ───────────────────────────────────────────────────────
  //
  // Shows documentation when the cursor rests on any identifier in an Android.bp
  // file. Two cases:
  //
  //   a) Word is a module type name — show property count and a preview list.
  //   b) Word is a property key inside a block — show type and full description,
  //      preferring the enclosing module's definition over the global fallback.
  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: 'android-bp', scheme: 'file' },
    {
      provideHover(document: vscode.TextDocument, position: vscode.Position) {
        const range = document.getWordRangeAtPosition(
          position,
          /[a-zA-Z_][a-zA-Z0-9_]*/
        );
        if (!range) { return undefined; }
        const word = document.getText(range);

        // Case a: module type name.
        if (data[word]) {
          const keys    = data[word];
          const preview = keys
            .slice(0, 8)
            .map(k => `- \`${k.key}\` *(${k.type})*`)
            .join('\n');
          return new vscode.Hover(
            new vscode.MarkdownString(
              `**${word}** — Android.bp module type\n\n` +
              `**${keys.length} properties**, including:\n${preview}` +
              (keys.length > 8 ? `\n- … *(${keys.length - 8} more)*` : '')
            )
          );
        }

        // Case b: property key inside a module block.
        const depth = getBraceDepth(document, position);
        if (depth >= 1) {
          const nodeName = getEnclosingNodeName(document, position);
          const nodeKeys = nodeName ? (data[nodeName] ?? []) : [];
          const keyDef   = nodeKeys.find(k => k.key === word)
                        ?? allKeys.find(k => k.key === word);
          if (keyDef) {
            const md = new vscode.MarkdownString(
              `**${keyDef.key}** *(${keyDef.type})*` +
              (keyDef.description ? `\n\n${keyDef.description}` : '')
            );
            md.isTrusted = true;
            return new vscode.Hover(md);
          }
        }

        return undefined;
      },
    }
  );

  context.subscriptions.push(completionProvider, pickKeysCommand, hoverProvider);
}

// Called when VS Code deactivates the extension (window close, disable, reload).
// All disposables are cleaned up automatically via context.subscriptions.
export function deactivate(): void {}
