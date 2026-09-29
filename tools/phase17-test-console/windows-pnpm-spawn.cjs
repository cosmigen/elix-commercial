'use strict'

const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

if (process.platform === 'win32') {
  const originalSpawn = childProcess.spawn

  childProcess.spawn = function phase17WindowsSpawn(command, args, options) {
    if (String(command).toLowerCase() === 'pnpm.cmd') {
      const shell = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
      return originalSpawn(shell, ['/d', '/c', 'pnpm.cmd', ...(args || [])], options)
    }
    return originalSpawn(command, args, options)
  }

  syncBuiltinESMExports()
}
