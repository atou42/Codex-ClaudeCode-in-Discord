import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSlashCommands, normalizeSlashCommandName, slashName, slashRef } from '../src/slash-command-surface.js';

class MockSlashCommandBuilder {
  constructor() {
    this.data = { options: [] };
  }

  setName(name) {
    this.data.name = name;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  addStringOption(configure) {
    const option = new MockSlashOptionBuilder();
    configure(option);
    this.data.options.push(option.data);
    return this;
  }

  addSubcommand(configure) {
    const option = new MockSlashSubcommandBuilder();
    configure(option);
    this.data.options.push(option.data);
    return this;
  }

  toJSON() {
    return this.data;
  }
}

class MockSlashOptionBuilder {
  constructor() {
    this.data = { choices: [] };
  }

  setName(name) {
    this.data.name = name;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setRequired(required) {
    this.data.required = required;
    return this;
  }

  addChoices(...choices) {
    this.data.choices.push(...choices);
    return this;
  }
}

class MockSlashSubcommandBuilder extends MockSlashOptionBuilder {
  constructor() {
    super();
    this.data.type = 'subcommand';
    this.data.options = [];
  }

  addStringOption(configure) {
    const option = new MockSlashOptionBuilder();
    configure(option);
    this.data.options.push(option.data);
    return this;
  }
}

test('slashName applies prefix and truncates to Discord limit', () => {
  assert.equal(slashName('status', 'cx'), 'cx_status');
  assert.equal(slashName('a'.repeat(40), 'prefix').length, 32);
});

test('normalizeSlashCommandName strips configured prefix only', () => {
  assert.equal(normalizeSlashCommandName('cx_status', 'cx'), 'status');
  assert.equal(normalizeSlashCommandName('status', 'cx'), 'status');
  assert.equal(normalizeSlashCommandName('cc_status', 'cx'), 'cc_status');
});

test('slashRef renders clickable command reference', () => {
  assert.equal(slashRef('progress', 'cx'), '/cx_progress');
  assert.equal(slashRef('progress', ''), '/progress');
});

test('buildSlashCommands includes workspace commands and aliases', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const names = commands.map((command) => command.name);
  assert.ok(names.includes('cx_setdir'));
  assert.ok(names.includes('cx_setdefaultdir'));
  assert.ok(names.includes('cx_new'));
  assert.ok(names.includes('cx_fork'));
  assert.ok(names.includes('cx_goal'));
  assert.ok(names.includes('cx_settings'));
  assert.ok(names.includes('cx_abort'));
  assert.ok(names.includes('cx_project_sessions'));
  assert.ok(names.includes('cx_chat_resume'));
  assert.ok(names.includes('cx_onboarding_config'));
  assert.ok(!names.includes('cx_retry'));
  assert.ok(!names.includes('cx_process_lines'));

  const goal = commands.find((command) => command.name === 'cx_goal');
  assert.deepEqual(goal.options.map((option) => option.name), ['objective', 'action', 'token_budget']);
  assert.equal(goal.options[0].required, false);
  assert.match(goal.options[0].description, /直接输入即可/);
  assert.deepEqual(goal.options[1].choices.map((choice) => choice.value), [
    'set',
    'status',
    'pause',
    'resume',
    'done',
    'clear',
    'budget',
  ]);
});

test('buildSlashCommands exposes browse keyword in workspace option descriptions', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const setdir = commands.find((command) => command.name === 'cx_setdir');
  const setdefaultdir = commands.find((command) => command.name === 'cx_setdefaultdir');

  assert.match(setdir.options[0].description, /browse/);
  assert.match(setdefaultdir.options[0].description, /browse/);
});

test('buildSlashCommands exposes all supported provider choices', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const provider = commands.find((command) => command.name === 'cx_provider');
  const choices = provider.options[0].choices.map((choice) => choice.value);

  assert.deepEqual(choices, ['codex', 'claude', 'cursor', 'grok', 'antigravity', 'zcode', 'pi', 'omp', 'status']);
});

test('buildSlashCommands registers model as a picker-only command', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: 'codex',
  }).map((command) => command.toJSON());

  const model = commands.find((command) => command.name === 'cx_model');
  assert.deepEqual(model.options, []);
});

test('buildSlashCommands gives provider-native alias descriptions to session aliases', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cx',
    botProvider: null,
  }).map((command) => command.toJSON());

  const projectSessions = commands.find((command) => command.name === 'cx_project_sessions');
  const chatResume = commands.find((command) => command.name === 'cx_chat_resume');

  assert.match(projectSessions.description, /project sessions/);
  assert.match(chatResume.description, /chat session/);
});

test('buildSlashCommands narrows locked-provider surfaces to native aliases and supported knobs', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'ag',
    botProvider: 'antigravity',
  }).map((command) => command.toJSON());

  const names = commands.map((command) => command.name);
  const compact = commands.find((command) => command.name === 'ag_compact');
  const sessions = commands.find((command) => command.name === 'ag_sessions');
  const resume = commands.find((command) => command.name === 'ag_resume');

  assert.ok(!names.includes('ag_provider'));
  assert.ok(!names.includes('ag_fork'));
  assert.ok(!names.includes('ag_effort'));
  assert.ok(names.includes('ag_chat_sessions'));
  assert.ok(!names.includes('ag_project_sessions'));
  assert.ok(names.includes('ag_chat_resume'));
  assert.ok(!names.includes('ag_rollout_resume'));
  assert.equal(sessions.description, '列出最近的 conversations');
  assert.equal(resume.description, '继承一个已有的 conversation');
  assert.deepEqual(compact.options[0].choices.map((choice) => choice.value), [
    'status',
    'run',
    'strategy',
    'token_limit',
    'enabled',
    'reset',
  ]);
});

test('buildSlashCommands makes Claude goal content the primary input', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'cc',
    botProvider: 'claude',
  }).map((command) => command.toJSON());

  const goal = commands.find((command) => command.name === 'cc_goal');
  assert.ok(goal);
  assert.deepEqual(goal.options.map((option) => option.name), ['objective', 'action']);
  assert.match(goal.options[0].description, /直接输入即可/);
  assert.deepEqual(goal.options[1].choices.map((choice) => choice.value), [
    'set',
    'status',
    'clear',
  ]);
});

test('buildSlashCommands registers fork for locked Grok', () => {
  const commands = buildSlashCommands({
    SlashCommandBuilder: MockSlashCommandBuilder,
    slashPrefix: 'grok',
    botProvider: 'grok',
  }).map((command) => command.toJSON());

  assert.ok(commands.some((command) => command.name === 'grok_fork'));
});

test('buildSlashCommands registers native goal actions for locked Grok, ZCode, and OMP', () => {
  for (const provider of ['grok', 'zcode', 'omp']) {
    const commands = buildSlashCommands({
      SlashCommandBuilder: MockSlashCommandBuilder,
      slashPrefix: provider,
      botProvider: provider,
    }).map((command) => command.toJSON());
    const goal = commands.find((command) => command.name === `${provider}_goal`);

    assert.ok(goal);
    assert.equal(goal.options[0].required, false);
    assert.deepEqual(goal.options[0].choices.map((choice) => choice.value), [
      'set',
      'status',
      'pause',
      'resume',
      'clear',
    ]);
    assert.deepEqual(
      goal.options.map((option) => option.name),
      provider === 'grok' ? ['action', 'objective', 'token_budget'] : ['action', 'objective'],
    );
  }
});
