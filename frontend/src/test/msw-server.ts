import { setupServer } from 'msw/node'

// No default handlers: every test declares the requests it expects, and
// setup.ts fails the run on an unhandled one. A component that quietly fetches
// something the test did not anticipate is a finding, not background noise.
export const server = setupServer()
