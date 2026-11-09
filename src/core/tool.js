/**
 * 工具自己的名字和版本，写进生成的数据里（Report.tool），以后能看出是哪个版本生成的
 * 从 package.json 读取，版本号只在一个地方维护
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export const TOOL = Object.freeze({ name: pkg.name, version: pkg.version })
