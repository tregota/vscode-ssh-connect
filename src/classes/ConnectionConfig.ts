import { ConnectConfig } from 'ssh2';

export interface PortForwardConfig {
    srcAddr?: string
    srcPort?: number
    dstAddr: string
    dstPort: number
    link: string
    autoConnect?: boolean
    description?: string
}

export default interface ConnectionConfig extends ConnectConfig {
    id: string
    description?: string
    iconPath?: string
    iconPathConnected?: string
    x11Port?: number
    portForwards?: PortForwardConfig[]
    loginPromptCommands?: Array<{ prompt: string, command: string, os?: "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "android" }>
    enableDebug?: boolean
}