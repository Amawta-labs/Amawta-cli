import type { ToolPermissionContextUpdate } from '@amawta-types/toolPermissionContext'

export type PermissionResult =
  | { result: true }
  | {
      result: false
      message: string
      shouldPromptUser?: boolean
      suggestions?: ToolPermissionContextUpdate[]
    }

