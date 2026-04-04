export type BuiltinSnippetCategory = 'ubuntu' | 'debian' | 'alpine' | 'huawei';

export interface BuiltinSnippetTemplate {
  id: string;
  category: BuiltinSnippetCategory;
  title: string;
  command: string;
  tags: string[];
  description: string;
}

export const builtinSnippetCategoryLabels: Record<BuiltinSnippetCategory, string> = {
  ubuntu: 'Ubuntu',
  debian: 'Debian',
  alpine: 'Alpine',
  huawei: '华为交换机/路由器'
};

export const builtinSnippetTemplates: BuiltinSnippetTemplate[] = [
  {
    id: 'builtin-ubuntu-apt-upgrade',
    category: 'ubuntu',
    title: '系统更新（APT）',
    command: 'sudo apt update && sudo apt upgrade -y',
    tags: ['系统维护', '更新'],
    description: '刷新软件源并升级已安装包，适合日常巡检前执行。'
  },
  {
    id: 'builtin-ubuntu-service-status',
    category: 'ubuntu',
    title: '检查服务状态',
    command: 'sudo systemctl status <service-name> --no-pager',
    tags: ['systemd', '排障'],
    description: '快速确认服务是否运行，替换 <service-name> 后使用。'
  },
  {
    id: 'builtin-ubuntu-service-log',
    category: 'ubuntu',
    title: '实时查看服务日志',
    command: 'sudo journalctl -u <service-name> -f --no-pager',
    tags: ['日志', 'systemd'],
    description: '持续追踪服务日志，适合定位启动失败或异常重启。'
  },
  {
    id: 'builtin-ubuntu-port-check',
    category: 'ubuntu',
    title: '端口监听检查',
    command: 'sudo ss -tulpn',
    tags: ['网络', '端口'],
    description: '查看监听端口与对应进程，判断服务是否正确绑定。'
  },
  {
    id: 'builtin-ubuntu-disk-usage',
    category: 'ubuntu',
    title: '磁盘空间巡检',
    command: 'df -h && sudo du -sh /var/log/* | sort -hr | head -n 15',
    tags: ['磁盘', '巡检'],
    description: '先看分区占用，再快速定位日志热点目录。'
  },
  {
    id: 'builtin-ubuntu-process-top',
    category: 'ubuntu',
    title: 'CPU/内存占用 Top',
    command: 'ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head -n 20',
    tags: ['性能', '进程'],
    description: '列出高 CPU 进程，适合卡顿场景快速定位。'
  },
  {
    id: 'builtin-ubuntu-firewall-status',
    category: 'ubuntu',
    title: 'UFW 防火墙状态',
    command: 'sudo ufw status verbose',
    tags: ['安全', '防火墙'],
    description: '核对 UFW 策略是否和预期一致。'
  },
  {
    id: 'builtin-ubuntu-restart-service',
    category: 'ubuntu',
    title: '重启并查看服务状态',
    command: 'sudo systemctl restart <service-name> && sudo systemctl status <service-name> --no-pager',
    tags: ['systemd', '恢复'],
    description: '常见故障恢复流程，重启后立即确认状态。'
  },
  {
    id: 'builtin-ubuntu-nginx-check',
    category: 'ubuntu',
    title: 'Nginx 配置自检并热重载',
    command: 'sudo nginx -t && sudo systemctl reload nginx',
    tags: ['nginx', '配置'],
    description: '先做语法检查，再执行平滑重载，降低发布风险。'
  },
  {
    id: 'builtin-ubuntu-docker-health',
    category: 'ubuntu',
    title: 'Docker 容器健康巡检',
    command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
    tags: ['docker', '巡检'],
    description: '查看容器状态和端口映射，快速定位异常实例。'
  },
  {
    id: 'builtin-ubuntu-security-patch',
    category: 'ubuntu',
    title: '安全更新预览',
    command: "apt list --upgradable 2>/dev/null | grep -Ei 'security|ubuntu-security' || true",
    tags: ['安全', '更新'],
    description: '发布前查看可升级安全补丁，便于制定维护窗口。'
  },
  {
    id: 'builtin-debian-install-tools',
    category: 'debian',
    title: '安装常用工具',
    command: 'sudo apt update && sudo apt install -y curl wget vim git net-tools',
    tags: ['初始化', '工具'],
    description: '新机初始化常用运维工具，便于后续排障与维护。'
  },
  {
    id: 'builtin-debian-package-check',
    category: 'debian',
    title: '检查软件包是否安装',
    command: "dpkg -l | grep -i '<package-name>'",
    tags: ['软件包', '排障'],
    description: '核对软件包安装状态，替换 <package-name>。'
  },
  {
    id: 'builtin-debian-syslog-tail',
    category: 'debian',
    title: '查看系统日志尾部',
    command: 'sudo tail -n 200 /var/log/syslog',
    tags: ['日志', '系统'],
    description: '快速回看系统最近日志，适合故障初步排查。'
  },
  {
    id: 'builtin-debian-time-sync',
    category: 'debian',
    title: '检查时钟同步状态',
    command: 'timedatectl status',
    tags: ['时间', 'NTP'],
    description: '核对系统时区和 NTP 同步状态，避免证书与鉴权异常。'
  },
  {
    id: 'builtin-debian-network-route',
    category: 'debian',
    title: '检查路由与网卡',
    command: 'ip addr && ip route',
    tags: ['网络', '路由'],
    description: '快速确认 IP、网关和默认路由是否正常。'
  },
  {
    id: 'builtin-debian-listening-port',
    category: 'debian',
    title: '查看监听端口',
    command: 'sudo ss -lntup',
    tags: ['端口', '网络'],
    description: '排查服务端口未监听或异常占用。'
  },
  {
    id: 'builtin-debian-security-upgrade',
    category: 'debian',
    title: '仅安装安全更新',
    command: 'sudo unattended-upgrade -d',
    tags: ['安全', '更新'],
    description: '在生产环境优先补齐安全修复。'
  },
  {
    id: 'builtin-debian-dmesg-warning',
    category: 'debian',
    title: '内核告警筛查',
    command: "sudo dmesg --color=never | egrep -i 'error|fail|warn' | tail -n 120",
    tags: ['内核', '排障'],
    description: '快速查看近期内核级异常与硬件告警。'
  },
  {
    id: 'builtin-debian-service-failed',
    category: 'debian',
    title: '列出失败服务',
    command: 'systemctl --failed --no-legend',
    tags: ['systemd', '排障'],
    description: '统一查看失败服务，适合系统恢复前的健康检查。'
  },
  {
    id: 'builtin-debian-apt-policy',
    category: 'debian',
    title: '查看软件源优先级',
    command: 'apt-cache policy <package-name>',
    tags: ['软件包', '源策略'],
    description: '排查版本异常时，确认软件包候选版本来源。'
  },
  {
    id: 'builtin-debian-fail2ban',
    category: 'debian',
    title: 'Fail2Ban 状态',
    command: 'sudo fail2ban-client status',
    tags: ['安全', '防暴力破解'],
    description: '查看入侵防护状态，确认 jail 是否生效。'
  },
  {
    id: 'builtin-alpine-update',
    category: 'alpine',
    title: '系统更新（APK）',
    command: 'sudo apk update && sudo apk upgrade',
    tags: ['系统维护', '更新'],
    description: 'Alpine 标准升级流程，常用于容器或轻量主机维护。'
  },
  {
    id: 'builtin-alpine-install-tools',
    category: 'alpine',
    title: '安装基础工具',
    command: 'sudo apk add --no-cache curl bash bind-tools iproute2',
    tags: ['初始化', '工具'],
    description: '补齐基础运维工具，适合最小化 Alpine 环境。'
  },
  {
    id: 'builtin-alpine-service-status',
    category: 'alpine',
    title: 'OpenRC 服务状态',
    command: 'sudo rc-service <service-name> status',
    tags: ['OpenRC', '排障'],
    description: '查看 OpenRC 服务状态，替换 <service-name> 后执行。'
  },
  {
    id: 'builtin-alpine-runlevel-services',
    category: 'alpine',
    title: '查看开机服务列表',
    command: 'sudo rc-update show',
    tags: ['OpenRC', '开机启动'],
    description: '列出当前 runlevel 的服务挂载情况。'
  },
  {
    id: 'builtin-alpine-network-check',
    category: 'alpine',
    title: '网络连通与 DNS',
    command: 'ip addr && ip route && cat /etc/resolv.conf',
    tags: ['网络', 'DNS'],
    description: '检查网卡、路由与 DNS 配置是否可用。'
  },
  {
    id: 'builtin-alpine-logs',
    category: 'alpine',
    title: '查看系统日志（BusyBox）',
    command: 'dmesg | tail -n 200',
    tags: ['日志', '系统'],
    description: 'Alpine 常用日志入口，适合容器或轻量系统。'
  },
  {
    id: 'builtin-alpine-disk',
    category: 'alpine',
    title: '磁盘和目录占用',
    command: 'df -h && du -sh /var/* | sort -hr | head -n 15',
    tags: ['磁盘', '巡检'],
    description: '巡检磁盘与目录体积，定位空间异常。'
  },
  {
    id: 'builtin-alpine-openrc-restart',
    category: 'alpine',
    title: '重启 OpenRC 服务',
    command: 'sudo rc-service <service-name> restart && sudo rc-service <service-name> status',
    tags: ['OpenRC', '恢复'],
    description: '重启并立即确认 OpenRC 服务状态。'
  },
  {
    id: 'builtin-alpine-repo-check',
    category: 'alpine',
    title: '检查 APK 源配置',
    command: 'cat /etc/apk/repositories',
    tags: ['apk', '源配置'],
    description: '核对 APK 仓库地址，排查安装失败与速度异常。'
  },
  {
    id: 'builtin-alpine-list-upgrade',
    category: 'alpine',
    title: '列出可升级包',
    command: 'apk version -l "<"',
    tags: ['更新', '软件包'],
    description: '先预览可升级包，再决定是否执行升级。'
  },
  {
    id: 'builtin-alpine-process',
    category: 'alpine',
    title: '高负载进程排行',
    command: 'ps waux | sort -nr -k 3 | head -n 20',
    tags: ['性能', '进程'],
    description: '排查 CPU 抖动或卡顿时快速定位热点进程。'
  },
  {
    id: 'builtin-huawei-version',
    category: 'huawei',
    title: '查看设备版本',
    command: 'display version',
    tags: ['设备信息', '巡检'],
    description: '确认设备型号、版本和运行时长，是巡检基础命令。'
  },
  {
    id: 'builtin-huawei-interface-brief',
    category: 'huawei',
    title: '查看接口概要',
    command: 'display interface brief',
    tags: ['接口', '链路'],
    description: '快速检查端口 up/down 状态与流量统计。'
  },
  {
    id: 'builtin-huawei-routing',
    category: 'huawei',
    title: '查看路由表',
    command: 'display ip routing-table',
    tags: ['路由', '网络'],
    description: '检查路由学习情况，定位可达性问题。'
  },
  {
    id: 'builtin-huawei-current-config',
    category: 'huawei',
    title: '查看当前配置',
    command: 'display current-configuration',
    tags: ['配置', '审计'],
    description: '查看设备当前运行配置，建议配合关键字过滤。'
  },
  {
    id: 'builtin-huawei-save-config',
    category: 'huawei',
    title: '保存当前配置',
    command: 'save',
    tags: ['配置', '持久化'],
    description: '将当前运行配置写入启动配置，执行前建议确认变更。'
  },
  {
    id: 'builtin-huawei-bgp-peer',
    category: 'huawei',
    title: '查看 BGP 邻居',
    command: 'display bgp peer',
    tags: ['BGP', '路由'],
    description: '确认 BGP 邻居状态与会话稳定性。'
  },
  {
    id: 'builtin-huawei-ospf-peer',
    category: 'huawei',
    title: '查看 OSPF 邻居',
    command: 'display ospf peer',
    tags: ['OSPF', '路由'],
    description: '检查 OSPF 邻接状态，定位收敛异常。'
  },
  {
    id: 'builtin-huawei-vlan-brief',
    category: 'huawei',
    title: '查看 VLAN 概要',
    command: 'display vlan summary',
    tags: ['VLAN', '二层'],
    description: '查看 VLAN 数量和分布，核对规划是否一致。'
  },
  {
    id: 'builtin-huawei-cpu-memory',
    category: 'huawei',
    title: '查看 CPU 与内存占用',
    command: 'display cpu-usage && display memory-usage',
    tags: ['性能', '巡检'],
    description: '巡检设备性能，发现异常负载趋势。'
  },
  {
    id: 'builtin-huawei-arp',
    category: 'huawei',
    title: '查看 ARP 表',
    command: 'display arp all',
    tags: ['ARP', '网络'],
    description: '排查二三层互通问题时的基础命令。'
  },
  {
    id: 'builtin-huawei-logbuffer',
    category: 'huawei',
    title: '查看系统日志缓冲',
    command: 'display logbuffer',
    tags: ['日志', '排障'],
    description: '定位近期链路抖动、协议 flap 等事件。'
  },
  {
    id: 'builtin-huawei-alarm',
    category: 'huawei',
    title: '查看当前活动告警',
    command: 'display alarm active',
    tags: ['告警', '巡检'],
    description: '值守场景下快速确认设备是否有未恢复告警。'
  },
  {
    id: 'builtin-huawei-interface-errors',
    category: 'huawei',
    title: '接口错误统计',
    command: 'display interface <interface-name>',
    tags: ['接口', '错误包'],
    description: '查看单端口错误、丢包、协商等详细状态。'
  }
];
