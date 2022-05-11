import { ConnectConfig } from 'ssh2';

export interface PortCommandConfig {
	id: string
	type: "process" | "terminal"
	command: string
}

export interface PortForwardConfig {
	srcAddr?: string
	srcPort: number
	dstAddr: string
	dstPort: number
  type: string
	autoConnect?: boolean
	commands: PortCommandConfig[]
}

export interface ConnectionCommandConfig {
	id: string
	command: string
}

export default interface ConnectionConfig extends ConnectConfig {
	id: string
	description?: string
	iconPath?: string
	folder?: string
	iconPathConnected?: string
	x11Port?: number
	jumpServer?: string
	portForwards?: PortForwardConfig[]
	commands: ConnectionCommandConfig[]
}