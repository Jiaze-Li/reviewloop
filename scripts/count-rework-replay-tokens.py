"""Offline tokenizer counts, not provider usage. Requires tiktoken; takes replay output directory."""
import json
from pathlib import Path
import sys
import tiktoken

root = Path(sys.argv[1])
labels = ['historical-full', 'repaired-full-before-fix', 'repaired-full-after-fix', 'repair-only-candidate']
results = {}
for encoding in ['cl100k_base', 'o200k_base']:
    tokenizer = tiktoken.get_encoding(encoding)
    counts = {}
    for label in labels:
        files = sorted(root.glob(f'{label}.*.txt'))
        if not files:
            raise ValueError(f'Missing prompt files for {label}')
        counts[label] = sum(len(tokenizer.encode(f.read_text(), disallowed_special=())) for f in files)
    counts['history_context_added'] = counts['repaired-full-after-fix'] - counts['repaired-full-before-fix']
    counts['repair_plus_full'] = counts['repair-only-candidate'] + counts['repaired-full-after-fix']
    counts['net_saved_vs_full'] = -counts['repair-only-candidate']
    results[encoding] = counts
(root / 'tokenizer-counts.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps(results, indent=2))
