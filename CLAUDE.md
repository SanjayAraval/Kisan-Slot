# SIH 26032 — Kisan Slot

Procurement slot booking and queue management for MSP paddy centres.
Ministry of Consumer Affairs, Food & Public Distribution.

## Core thesis
A slot is a promise about capacity. Daily slot count is derived from
min() across weighbridge cycle, hamali gangs, gunny bag stock, truck
evacuation, and yard space — never a fixed number. Surface which
constraint is binding.

## Non-negotiables
- Offline-first. Rural centres lose connectivity.
- Everything on the critical path (register, book, queue, payment
  status) must work over SMS and IVR. App-only is a fail.
- 20% of daily capacity reserved for walk-ins.
- Registration is confirmation of pre-seeded land-record data, not
  data entry.
- J-Form is immutable once issued; corrections create linked revisions.
- Itemise every deduction between MSP and net payable.

## Stack
React + Node/Express + PostgreSQL. Redis for live queue.
Mock the Dharani and PFMS integrations behind a defined interface.
