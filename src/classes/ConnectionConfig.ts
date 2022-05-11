import { ConnectConfig } from 'ssh2';

export interface PortForwardConfig {
	srcAddr?: string
	srcPort: number
	dstAddr: string
	dstPort: number
  type: string
	autoConnect?: boolean
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
}