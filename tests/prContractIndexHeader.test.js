// R09 / AC13: the contract-index parser must accept every hand-written header
// spelling ("任务", "任务 ID", "任务ID") without relaxing data-row validation.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PrContractError,
  formatContractComments,
  parseContractIndex,
  recoverPrContract,
} from '../src/reviewloop/prContract.js';

const SHA = 'a'.repeat(64);
const row = (type = 'Plan', sha = `\`${SHA}\``, status = 'current') =>
  `| T-1 | ${type} | v1 | [111](https://github.com/o/r/pull/1#issuecomment-111) | ${sha} | 1/1 | ${status} |`;

function table(header, rows) {
  return [
    '## Brief', '', '### 合同索引', '',
    header, '|---|---|---|---|---|---|---|', ...rows, '',
  ].join('\n');
}

const HEADERS = [
  '| 任务 | 类型 | 版本 | 评论 ID | SHA-256 | 分段 | 状态 |',
  '| 任务 ID | 类型 | 版本 | 评论 ID (databaseId) | SHA-256 | 分段 | 状态 |',
  '| 任务ID | 类型 | 版本 | 评论 ID | SHA-256 | 分段 | 状态 |',
  '|  任务   ID  | 类型 | 版本 | 评论 ID | SHA-256 | 分段 | 状态 |',
];

test('every supported header spelling parses to the same single data row', () => {
  for (const header of HEADERS) {
    const rows = parseContractIndex(table(header, [row()]));
    assert.equal(rows.length, 1, header);
    assert.equal(rows[0].taskId, 'T-1');
    assert.equal(rows[0].type, 'plan');
    assert.equal(rows[0].status, 'current');
  }
});

test('data-row validation is unchanged for every header spelling', () => {
  for (const header of HEADERS) {
    assert.throws(() => parseContractIndex(table(header, [row('Bogus')])), (e) =>
      e instanceof PrContractError && e.code === 'PR_CONTRACT_INVALID_TYPE', header);
    assert.throws(() => parseContractIndex(table(header, [row('Plan', '`zz`')])), (e) =>
      e.code === 'PR_CONTRACT_INDEX_INVALID', header);
    assert.throws(() => parseContractIndex(table(header, ['| T-1 | Plan | v1 |'])), (e) =>
      e.code === 'PR_CONTRACT_INDEX_INVALID', header);
    assert.throws(() => parseContractIndex(table(header, [row(), row()])), (e) =>
      e.code === 'PR_CONTRACT_MULTIPLE_CURRENT', header);
  }
});

test('headers with other column titles or fewer columns stay accepted, as before this change', () => {
  for (const header of ['| 任务 | 种类 | 版本 | 评论 | SHA | 分段 | 状态 |', '| 任务 ID | 类型 |', '| 任务 |']) {
    assert.equal(parseContractIndex(table(header, [row()])).length, 1, header);
  }
});

test('a data row with an invalid type is still rejected when its first cell is an ordinary task id', () => {
  assert.throws(() => parseContractIndex(table(HEADERS[0], [row('类型')])), (e) => e.code === 'PR_CONTRACT_INVALID_TYPE');
});

test('recoverPrContract works against a PR description using the "任务 ID" header (PR #59 shape)', async () => {
  const content = '# Plan\n\nbody\n';
  const formatted = formatContractComments({ taskId: 'T-59', type: 'plan', version: 'v1.4', content });
  const prBody = [
    '### 合同索引', '',
    '| 任务 ID | 类型 | 版本 | 评论 ID (databaseId) | SHA-256 | 分段 | 状态 |',
    '|---|---|---|---|---|---|---|',
    `| T-59 | Plan | v1.3 | [900](https://github.com/Jiaze-Li/reviewloop/pull/59#issuecomment-900) | \`${'b'.repeat(64)}\` | 1/1 | superseded |`,
    `| T-59 | Plan | v1.4 | [901](https://github.com/Jiaze-Li/reviewloop/pull/59#issuecomment-901) | \`${formatted.sha256}\` | 1/1 | current |`,
  ].join('\n');
  const runGh = async (args) => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return JSON.stringify({ body: prBody, headRefOid: 'c'.repeat(40), baseRefName: 'main', headRefName: 'plan/x', url: 'https://github.com/Jiaze-Li/reviewloop/pull/59' });
    }
    if (args[0] === 'api' && args[1] === 'repos/Jiaze-Li/reviewloop/issues/comments/901') {
      return JSON.stringify({ id: 901, node_id: 'IC_1', issue_url: 'https://api.github.com/repos/Jiaze-Li/reviewloop/issues/59', user: { login: 'Jiaze-Li' }, body: formatted.comments[0].body });
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { node: { lastEditedAt: null, userContentEdits: { totalCount: 0 } } } });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const recovered = await recoverPrContract({ repo: 'Jiaze-Li/reviewloop', prNumber: 59, taskId: 'T-59', type: 'plan', runGh });
  assert.equal(recovered.sha256, formatted.sha256);
  assert.equal(recovered.version, 'v1.4');
});
