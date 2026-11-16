#!/usr/bin/env node
// drawio-inventory: read a .drawio file and write a deterministic inventory of its
// nodes, groups, edges and AWS services, plus an optional draft Archify
// "executive view" candidate. No dependencies; Node 18+.
//
// The script only reports what is in the drawing. It never invents nodes,
// links, CIDRs, ports or protocols. The source file is never modified.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GLOSSARY = join(HERE, '..', 'glossary', 'aws.json');

const USAGE = `Usage: node drawio-inventory.mjs <file.drawio> [options]

Options:
  --page <n|name>           Diagram page to read (1-based number or page name; default 1)
  --glossary <file>         Glossary JSON (default: glossary/aws.json next to this script)
  --out <file>              Write the inventory JSON to this file (default: stdout)
  --executive-draft <file>  Also write a draft Archify architecture candidate (executive view)
  --title <text>            Title for the executive draft
  --html <path>             meta.output for the draft, POSIX-relative .html (default: <name>-executive.html)
  -h, --help                Show this help
`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) {
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`Missing value for ${a}`);
      opts[a.slice(2)] = val;
      i++;
    } else opts.positional.push(a);
  }
  return opts;
}

// ---------------------------------------------------------------- XML helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

function parseAttrs(s) {
  const out = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

// Labels are often HTML (html=1). Turn them into one line of plain text.
function plainText(value) {
  if (!value) return '';
  const s = value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(div|p|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function parseStyle(style) {
  const out = { _name: null };
  for (const raw of (style || '').split(';')) {
    const part = raw.trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      if (!out._name) out._name = part;
      out[part] = '1';
    } else out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

const num = (v) => (v === undefined || v === '' ? 0 : Number(v) || 0);

// ---------------------------------------------------------------- pages

function inflatePage(text) {
  let raw;
  try {
    raw = inflateRawSync(Buffer.from(text, 'base64')).toString('utf8');
  } catch {
    throw new Error('Could not decompress a <diagram> page. In draw.io turn off File > Properties > Compressed and save again.');
  }
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function loadPages(xml) {
  const pages = [];
  const re = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    let body = m[2].trim();
    if (!body.includes('<mxGraphModel')) body = inflatePage(body);
    pages.push({ name: attrs.name || `Page-${pages.length + 1}`, model: body });
  }
  if (!pages.length && xml.includes('<mxGraphModel')) pages.push({ name: 'Page-1', model: xml });
  if (!pages.length) throw new Error('No draw.io diagram found in the file.');
  return pages;
}

function pickPage(pages, sel) {
  if (sel === undefined) return pages[0];
  if (/^\d+$/.test(sel)) {
    const p = pages[Number(sel) - 1];
    if (!p) throw new Error(`Page ${sel} does not exist (file has ${pages.length}).`);
    return p;
  }
  const p = pages.find((x) => x.name === sel);
  if (!p) throw new Error(`No page named "${sel}". Pages: ${pages.map((x) => x.name).join(', ')}`);
  return p;
}

// ---------------------------------------------------------------- cells

function parseCells(model) {
  const cells = [];
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(model))) {
    const [, closing, tag, rest, selfClose] = m;
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = parseAttrs(rest);
    const frame = { tag, attrs };
    const top = stack[stack.length - 1];
    if (tag === 'mxCell') {
      const cell = { ...attrs };
      // <object>/<UserObject> wrappers carry the id and label of the cell inside them.
      if (top && (top.tag === 'object' || top.tag === 'UserObject')) {
        cell.id = top.attrs.id ?? cell.id;
        cell.value = top.attrs.label ?? cell.value ?? '';
      }
      cells.push(cell);
      frame.cell = cell;
    } else if (tag === 'mxGeometry' && top && top.cell && attrs.as === 'geometry') {
      top.cell.geometry = {
        x: num(attrs.x), y: num(attrs.y), width: num(attrs.width), height: num(attrs.height),
        relative: attrs.relative === '1',
      };
    }
    if (!selfClose) stack.push(frame);
  }
  return cells;
}

// ---------------------------------------------------------------- classification

const GROUP_ICONS = {
  group_aws_cloud: 'cloud', group_aws_cloud_alt: 'cloud', group_region: 'region',
  group_vpc: 'vpc', group_vpc2: 'vpc', group_account: 'account',
  group_corporate_data_center: 'datacenter', group_on_premise: 'datacenter',
  group_security_group: 'security-group', group_auto_scaling_group: 'auto-scaling',
  group_ec2_instance_contents: 'instance', group_spot_fleet: 'spot-fleet',
  group_elastic_beanstalk: 'beanstalk', group_aws_step_functions_workflow: 'workflow',
};

function groupKind(st, label) {
  const l = label.toLowerCase();
  if (/subnet/.test(l)) return 'subnet';
  if (/availability zone|\baz\s*-?\s*[a-z0-9]?\b/.test(l)) return 'az';
  const icon = st.grIcon && st.grIcon.replace(/^mxgraph\.aws4\./, '');
  if (icon && GROUP_ICONS[icon]) return GROUP_ICONS[icon];
  if (/\bvpc\b/.test(l)) return 'vpc';
  if (/account/.test(l)) return 'account';
  if (/region/.test(l)) return 'region';
  if (/aws cloud/.test(l)) return 'cloud';
  if (/data ?cent|on-?prem/.test(l)) return 'datacenter';
  return 'group';
}

function serviceKey(st) {
  const strip = (v) => (v && v.startsWith('mxgraph.aws4.') ? v.slice('mxgraph.aws4.'.length) : null);
  if (st.resIcon) return strip(st.resIcon);
  if (st.prIcon) return strip(st.prIcon);
  const s = strip(st.shape);
  if (s && !['group', 'groupCenter', 'resourceIcon', 'productIcon'].includes(s)) return s;
  return null;
}

function lookup(glossary, key) {
  if (!key) return null;
  const k = key.toLowerCase();
  const candidates = [k, glossary.aliases?.[k], k.replace(/_\d+$/, ''), glossary.aliases?.[k.replace(/_\d+$/, '')]];
  for (const c of candidates) if (c && glossary.services[c]) return { key: c, ...glossary.services[c] };
  return null;
}

// Labels that differ only by AZ, role or a trailing index fold into one component.
const ROLE_WORDS = /\b(primary|secondary|standby|replica|reader|writer|leader|follower|active|passive)\b/gi;

function normLabel(label) {
  return label
    .toLowerCase()
    .replace(/\b(availability zone|az|zone)\s*[-_]?\s*[a-z0-9]\b/g, ' ')
    .replace(ROLE_WORDS, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s(\d+|[a-c])$/, '')
    .trim();
}

function displayLabel(label) {
  return label
    .replace(ROLE_WORDS, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- customer-safe flags

const FLAG_RULES = [
  ['price', /(?:\b(?:USD|MYR|RM|SGD|EUR|GBP|IDR|AUD)\s?\d[\d,.]*|\$\s?\d[\d,.]*|\d[\d,.]*\s?(?:USD|MYR)\b)/i],
  ['aws-account-id', /\b\d{12}\b/],
  ['cidr-or-ip', /\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/],
  ['email', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['internal-wording', /\b(internal|confidential|map funding|discount|margin|do not share)\b/i],
];

function scanFlags(items) {
  const flags = [];
  for (const { id, where, text } of items) {
    if (!text) continue;
    for (const [kind, re] of FLAG_RULES) if (re.test(text)) flags.push({ id, where, kind, text });
  }
  return flags;
}

// ---------------------------------------------------------------- inventory

function buildInventory(cells, glossary, meta) {
  const byId = new Map(cells.map((c) => [c.id, c]));
  const isLayer = (c) => c && (c.id === '0' || c.parent === '0' || (!c.parent && c.vertex !== '1' && c.edge !== '1'));
  const isEdge = (c) => c && c.edge === '1';

  const vertexChildren = new Map();
  for (const c of cells) {
    if (c.vertex !== '1' || !c.parent) continue;
    if (!vertexChildren.has(c.parent)) vertexChildren.set(c.parent, []);
    vertexChildren.get(c.parent).push(c.id);
  }

  const absMemo = new Map();
  const abs = (id) => {
    if (absMemo.has(id)) return absMemo.get(id);
    const c = byId.get(id);
    let p = { x: 0, y: 0 };
    if (c && !isLayer(c) && !isEdge(c) && c.geometry) {
      const base = abs(c.parent);
      p = { x: base.x + c.geometry.x, y: base.y + c.geometry.y };
    }
    absMemo.set(id, p);
    return p;
  };

  const nodes = [], groups = [], texts = [], edges = [];
  const edgeLabelParts = new Map();
  const groupIds = new Set();

  for (const c of cells) {
    if (c.vertex !== '1' || isLayer(c)) continue;
    const st = parseStyle(c.style);
    const label = plainText(c.value);
    const parent = byId.get(c.parent);
    if (isEdge(parent)) { // label attached to an edge
      if (label) {
        if (!edgeLabelParts.has(parent.id)) edgeLabelParts.set(parent.id, []);
        edgeLabelParts.get(parent.id).push(label);
      }
      continue;
    }
    const isGroup = st.container === '1' || st.shape === 'mxgraph.aws4.group' || st.shape === 'mxgraph.aws4.groupCenter'
      || st._name === 'group' || st.swimlane === '1' || (vertexChildren.get(c.id) || []).length > 0;
    if (isGroup) groupIds.add(c.id);
  }

  const ancestry = (id) => {
    const out = [];
    let c = byId.get(byId.get(id)?.parent);
    while (c && !isLayer(c)) {
      if (groupIds.has(c.id)) out.push(c.id);
      c = byId.get(c.parent);
    }
    return out;
  };

  const groupInfo = new Map();
  for (const c of cells) {
    if (!groupIds.has(c.id)) continue;
    const st = parseStyle(c.style);
    const label = plainText(c.value);
    const g = {
      id: c.id, kind: groupKind(st, label), label,
      parent: ancestry(c.id)[0] ?? null,
      pos: [abs(c.id).x, abs(c.id).y], size: [c.geometry?.width ?? 0, c.geometry?.height ?? 0],
    };
    groupInfo.set(c.id, g);
    groups.push(g);
  }

  for (const c of cells) {
    if (c.vertex !== '1' || isLayer(c) || groupIds.has(c.id) || isEdge(byId.get(c.parent))) continue;
    const st = parseStyle(c.style);
    const label = plainText(c.value);
    const service = serviceKey(st);
    if (!service && (st._name === 'text' || st.text === '1')) {
      if (label) texts.push({ id: c.id, text: label });
      continue;
    }
    if (!service && !label) continue; // decoration
    const g = lookup(glossary, service);
    const anc = ancestry(c.id).map((id) => groupInfo.get(id));
    const az = anc.find((x) => x.kind === 'az');
    const p = abs(c.id);
    nodes.push({
      id: c.id,
      label: label || g?.aws || service,
      service,
      glossaryKey: g?.key ?? null,
      aws: g?.aws ?? null,
      plain: g?.plain ?? null,
      does: g?.does ?? null,
      layer: g?.layer ?? 'unknown',
      az: az ? az.label : null,
      groups: anc.map((x) => ({ id: x.id, kind: x.kind, label: x.label })),
      pos: [p.x, p.y],
      size: [c.geometry?.width ?? 0, c.geometry?.height ?? 0],
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const report = { danglingEdges: [], groupEndpoints: [] };
  for (const c of cells) {
    if (!isEdge(c)) continue;
    const st = parseStyle(c.style);
    const parts = [plainText(c.value), ...(edgeLabelParts.get(c.id) || [])].filter(Boolean);
    const e = {
      id: c.id, source: c.source ?? null, target: c.target ?? null,
      label: parts.join(' / ') || null, dashed: st.dashed === '1',
    };
    if (!e.source || !e.target || !byId.has(e.source) || !byId.has(e.target)) {
      report.danglingEdges.push(e);
      continue;
    }
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) report.groupEndpoints.push(e);
    edges.push(e);
  }

  // Fold candidates: same service and same label once AZ/role/index is removed.
  const foldMap = new Map();
  for (const n of nodes) {
    const norm = normLabel(n.label);
    if (!norm) continue;
    const key = `${n.service ?? 'generic'}|${norm}`;
    if (!foldMap.has(key)) foldMap.set(key, []);
    foldMap.get(key).push(n);
  }
  const folds = [];
  for (const [key, members] of foldMap) {
    if (members.length < 2) continue;
    folds.push({
      key,
      label: displayLabel(members[0].label),
      service: members[0].service,
      count: members.length,
      members: members.map((m) => m.id),
      memberLabels: members.map((m) => m.label),
      azs: [...new Set(members.map((m) => m.az).filter(Boolean))],
      internalEdges: edges.filter((e) => members.some((m) => m.id === e.source) && members.some((m) => m.id === e.target)).map((e) => e.id),
    });
  }

  const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
  report.folds = folds;
  report.unconnectedNodes = nodes.filter((n) => !connected.has(n.id)).map((n) => ({ id: n.id, label: n.label }));
  report.unknownServices = nodes.filter((n) => n.layer === 'unknown').map((n) => ({ id: n.id, label: n.label, service: n.service }));
  report.flags = scanFlags([
    ...nodes.map((n) => ({ id: n.id, where: 'node', text: n.label })),
    ...groups.map((g) => ({ id: g.id, where: 'group', text: g.label })),
    ...edges.map((e) => ({ id: e.id, where: 'edge', text: e.label })),
    ...texts.map((t) => ({ id: t.id, where: 'text', text: t.text })),
  ]);
  report.annotations = texts;

  const azs = [...new Set(groups.filter((g) => g.kind === 'az').map((g) => g.label))];
  const regions = [...new Set(groups.filter((g) => g.kind === 'region').map((g) => g.label))];

  return {
    tool: 'drawio-inventory',
    version: 1,
    source: meta,
    summary: {
      nodes: nodes.length, groups: groups.length, edges: edges.length, annotations: texts.length,
      services: [...new Set(nodes.map((n) => n.aws || n.service).filter(Boolean))].sort(),
      regions, availabilityZones: azs,
      flags: report.flags.length, unknownServices: report.unknownServices.length,
    },
    nodes, groups, edges, report,
  };
}

// ---------------------------------------------------------------- executive draft

const ROW_ORDER = ['above', 'main', 'below'];
const COL_PITCH = 300, ROW_PITCH = 160, BOX = [160, 64], ORIGIN = [40, 40];

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagram';
}

function executiveDraft(inv, glossary, opts) {
  const L = glossary.layers;
  const layerOrder = Object.keys(L);
  const shown = (layer) => L[layer] && L[layer].executive !== false;
  const nodeById = new Map(inv.nodes.map((n) => [n.id, n]));

  // Node-level links, then contract through nodes that the executive view omits,
  // so A -> NAT -> B still reads as A -> B. No link is created without a path in the drawing.
  let links = inv.edges.filter((e) => nodeById.has(e.source) && nodeById.has(e.target)).map((e) => [e.source, e.target]);
  const omitted = inv.nodes.filter((n) => !shown(n.layer));
  for (const n of omitted) {
    const ins = links.filter(([a, b]) => b === n.id && a !== n.id).map(([a]) => a);
    const outs = links.filter(([a, b]) => a === n.id && b !== n.id).map(([, b]) => b);
    links = links.filter(([a, b]) => a !== n.id && b !== n.id);
    for (const a of ins) for (const b of outs) if (a !== b) links.push([a, b]);
  }

  const byLayer = new Map();
  for (const n of inv.nodes) {
    if (!shown(n.layer)) continue;
    if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
    byLayer.get(n.layer).push(n);
  }
  const layers = layerOrder.filter((l) => byLayer.has(l));

  // Slot placement from the glossary, first free slot wins.
  const taken = new Set();
  const place = new Map();
  for (const l of layers) {
    const wanted = [...(L[l].slots || []), ...ROW_ORDER.flatMap((r) => [1, 2, 3].map((c) => [r, c]))];
    const slot = wanted.find(([r, c]) => !taken.has(`${r}:${c}`));
    taken.add(`${slot[0]}:${slot[1]}`);
    place.set(l, slot);
  }
  const usedRows = ROW_ORDER.filter((r) => [...place.values()].some(([row]) => row === r));
  const rowY = Object.fromEntries(usedRows.map((r, i) => [r, ORIGIN[1] + i * ROW_PITCH]));

  const blockId = (l) => `blk-${l}`;
  const components = layers.map((l) => {
    const members = byLayer.get(l);
    const [row, col] = place.get(l);
    const label = l === 'people' || l === 'onprem'
      ? [...new Set(members.map((m) => m.label))].slice(0, 2).join(' & ')
      : L[l].title;
    return {
      id: blockId(l), type: L[l].type, label, sublabel: L[l].sublabel, icon: L[l].icon,
      pos: [ORIGIN[0] + col * COL_PITCH, rowY[row]], size: [...BOX],
    };
  });

  const seen = new Set();
  const connections = [];
  for (const [a, b] of links) {
    const la = nodeById.get(a).layer, lb = nodeById.get(b).layer;
    if (la === lb || !byLayer.has(la) || !byLayer.has(lb)) continue;
    if (seen.has(`${la}>${lb}`) || seen.has(`${lb}>${la}`)) continue;
    seen.add(`${la}>${lb}`);
    const label = L[la].outgoingVerb || L[lb].incomingVerb;
    connections.push({
      id: `${la}-to-${lb}`, from: blockId(la), to: blockId(lb),
      ...(label ? { label } : {}),
      ...(la === 'people' ? { variant: 'emphasis' } : la === 'security' ? { variant: 'security' } : {}),
    });
  }

  const cloudBlocks = layers.filter((l) => l !== 'people' && l !== 'onprem').map(blockId);
  const region = inv.summary.regions[0];
  const boundaries = cloudBlocks.length
    ? [{ kind: 'region', label: region ? `Hosted on AWS (${region.replace(/^aws\s+region:?\s*/i, '')})` : 'Hosted on AWS', wraps: cloudBlocks }]
    : [];

  const inside = layers.filter((l) => l !== 'people').map((l) => {
    const names = [...new Set(byLayer.get(l).map((m) => m.aws || m.label))];
    return `${L[l].title}: ${names.join(', ')}`;
  });
  const cards = [{ dot: 'slate', title: "What's inside", items: inside }];
  const multiAz = inv.report.folds.filter((f) => f.azs.length >= 2);
  if (multiAz.length) {
    const zones = Math.max(...multiAz.map((f) => f.azs.length));
    const sel = multiAz.filter((f) => shown(nodeById.get(f.members[0]).layer));
    cards.push({
      dot: 'emerald', title: 'Resilience',
      items: [
        `Key parts run in ${zones} separate Availability Zones (isolated data centre groups)`,
        ...(sel.length ? [`Duplicated across zones: ${sel.map((f) => f.label).join(', ')}`] : []),
      ],
    });
  }

  const base = basename(inv.source.file, extname(inv.source.file));
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: opts.title || `${base} - overview`,
      output: opts.html || `${slug(base)}-executive.html`,
      quality_profile: 'showcase',
      locale: 'en',
    },
    components,
    boundaries,
    connections,
    cards,
    _omitted: omitted.map((n) => ({ id: n.id, label: n.label, layer: n.layer })),
  };
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts.positional.length !== 1) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  const file = resolve(opts.positional[0]);
  const glossary = JSON.parse(readFileSync(resolve(opts.glossary || DEFAULT_GLOSSARY), 'utf8'));
  const pages = loadPages(readFileSync(file, 'utf8'));
  const page = pickPage(pages, opts.page);
  const cells = parseCells(page.model);
  const inv = buildInventory(cells, glossary, { file: basename(file), page: page.name, pages: pages.map((p) => p.name) });

  if (opts['executive-draft']) {
    const draft = executiveDraft(inv, glossary, opts);
    inv.report.omittedFromExecutive = draft._omitted;
    delete draft._omitted;
    mkdirSync(dirname(resolve(opts['executive-draft'])), { recursive: true });
    writeFileSync(resolve(opts['executive-draft']), JSON.stringify(draft, null, 2) + '\n');
  }

  const json = JSON.stringify(inv, null, 2) + '\n';
  if (opts.out) {
    mkdirSync(dirname(resolve(opts.out)), { recursive: true });
    writeFileSync(resolve(opts.out), json);
  } else process.stdout.write(json);

  const s = inv.summary;
  process.stderr.write(
    `${s.nodes} nodes, ${s.groups} groups, ${s.edges} edges; ${inv.report.folds.length} fold candidates; ` +
    `${s.unknownServices} unknown services; ${s.flags} customer-safe flags\n`,
  );
  if (s.flags) for (const f of inv.report.flags) process.stderr.write(`  FLAG ${f.kind}: ${f.where} ${f.id}: "${f.text}"\n`);
}

try { main(); } catch (err) {
  process.stderr.write(`drawio-inventory: ${err.message}\n`);
  process.exit(1);
}
