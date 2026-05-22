# Agent Request

## Request Type

`hire_agent` | `upgrade_agent` | `permission_change`

## Agent

- agent_id:
- reports_to:
- product_or_team:
- risk_level: low | medium | high
- data_classification: public | internal | confidential

## Business Need

What repeated work should this agent own?

## Why Existing Agents Are Not Enough

What breaks if this remains direct human/orchestrator work?

## Inputs

What context may the agent receive?

## Outputs

What must the agent produce?

## Permissions Requested

- tools:
- memory_scope:
- write_scope:
- external_actions:

## Guardrails

What must the agent refuse, escalate, or avoid?

## Evals

List 2-3 realistic prompts:

1.
2.
3.

## Rollback Plan

How do we disable this agent or permission safely?

