"""Chapter 7 of 'PgCloud - The Master Book' (v1.2.0): what is new in 1.2.0."""
from bookstyle import H, P, PageBreak, Spacer, bullets, code, figure, note, table


def chapter7():
    s = [PageBreak()]
    s += H(1, '7', "What's new in 1.2.0")
    s.append(P('Version 1.2.0 is about **surviving outages**: nodes that stand in for failed ones, a cluster that '
               'recovers from a complete power cut by itself, an emergency copy when the last copy of the data is at '
               'risk, a clear warning when applications cannot reach the database, and a recorder to audit what '
               'happened afterwards. Everything in this chapter was tried on the launcher playground (five servers) '
               'before the release; the measured times are in section 7.7.'))
    s += table([
        ['Feature', 'Where', 'In one sentence'],
        ['Backup nodes', 'Palette → Backup', 'Replicas that serve no traffic and take over when a node fails, then hand the work back.'],
        ['Topology follows failovers', 'Automatic', 'When Pgpool-II promotes a replica, the drawing and the configuration files follow.'],
        ['Old-primary guard', 'Settings', 'An old primary never starts as a second primary: it rejoins, or waits for you.'],
        ['Auto-heal', 'Settings', 'Rejoins old primaries and re-attaches healthy nodes that Pgpool-II keeps detached.'],
        ['Fast-swap', 'Red banner', 'Emergency copy of the freshest data to a new server when the cluster is about to lose it.'],
        ['"System not accessible"', 'Bottom-right card', 'Says why no entry point answers, layer by layer, and offers the fixes.'],
        ['Audit recordings', 'REC button, Audit tab', 'One timeline of events, operations and container logs, downloadable.'],
        ['Destroy & rebuild', 'Deploy → Danger zone', 'Deletes every node and its data and deploys the cluster again.'],
    ], widths=[26, 22, 62])

    # ------------------------------------------------------------------ 7.1
    s += H(2, '7.1', 'Backup nodes')
    s.append(P('A **backup** is a PostgreSQL node that streams from the primary like a replica, but **accepts neither '
               'reads nor writes** from the applications: no Pgpool-II or PgBouncer may be linked to it (the validation '
               'refuses such links) and Pgpool-II never balances queries to it. It waits, with a full and current copy '
               'of the data, until the cluster needs it. Add one from the palette (*Backup*), or tick *Backup node* '
               'in the inspector of a PostgreSQL node, and link it to the primary.'))
    s += figure('71-topology-backups', 'Figure 7.1 - pg2 and pg4 are idle backups (hatched, BACKUP · P10, no Pgpool-II '
                'link); pg3 was a backup and has been promoted to a system node (EX-BACKUP).', max_height=300)
    s += H(3, '7.1.1', 'The life of a backup')
    s += table([
        ['State', 'Drawn as', 'Traffic', 'Links to Pgpool-II / PgBouncer'],
        ['Idle backup', 'hatched, BACKUP · P<priority>', 'none', 'forbidden'],
        ['Backup in service', 'amber border, BACKUP · IN SERVICE + the role it serves as', 'like a replica or the primary',
         'the ones of the node it replaces, moved by the launcher'],
        ['System node (ex-backup)', 'normal node, EX-BACKUP tag and a notice', 'normal', 'normal'],
    ], widths=[20, 34, 20, 30])
    s.append(P('What a backup does is set in its inspector:'))
    s += table([
        ['Option', 'What happens'],
        ['Keep the number of replicas', 'A PostgreSQL node stays down longer than the grace time while a primary serves: '
         'the backup serves as a replica in its place. The Pgpool-II and PgBouncer links of the failed node move to the '
         'backup and every Pgpool-II node is redeployed with the new backend list.'],
        ['Last resort', 'Every normal PostgreSQL node is down: the backup is promoted to primary, the drawing and '
         'Pgpool-II follow it.'],
        ['Return to backup when the cluster recovers (on by default)', 'Once the node it replaced runs again and stays '
         'healthy for the grace time, the backup hands the work back: the links return to that node, Pgpool-II is '
         'redeployed and the backup is idle again. If it serves as the primary, it first hands the role to a recovered '
         'replica with a planned switchover, so no committed transaction is lost.'],
        ['Return to backup off', 'The first time it acts, the backup becomes a system node for good. The node it replaced '
         'becomes the backup (the number of nodes of each kind stays the same) and a notice says so.'],
        ['Backup priority', 'With several backups, the highest priority that can act is used first.'],
        ['Act after a node is down for (s)', 'Grace time before acting, and time the recovered node must stay healthy '
         'before the backup hands the work back (default 60 s).'],
    ], widths=[34, 76])
    s += figure('74-inspector-backup', 'Figure 7.2 - Options of a backup node. It cannot be made primary by hand.',
                max_height=360)
    s += H(3, '7.1.2', 'A backup is never made primary by hand')
    s.append(P('The inspector of a backup has no *Make primary* button and the launcher refuses a switchover or a '
               '*Promote* that targets one, from the interface or from the API. A backup only becomes the primary by '
               'itself, as a last resort. To use it as a normal node, untick *Backup node*: it becomes a system node '
               'and every operation is available again. A backup found running as the primary anyway (promoted by '
               'Pgpool-II) is treated as a backup in service and hands the role back in the same way.'))
    s += figure('73-inspector-promoted', 'Figure 7.3 - Notice of a backup promoted to a system node ("Return to backup" '
                'was off). Dismiss removes it.', max_height=300)
    s += note('Direct connections.', 'Applications must connect through PgBouncer or Pgpool-II. A client that connects '
              'straight to port 5432 of a backup can still read from it (it is a hot standby): see section 7.9.')

    # ------------------------------------------------------------------ 7.2
    s += H(2, '7.2', 'Recovering from outages')
    s.append(P('1.2.0 adds several mechanisms that work together, so that a cluster comes back on its own after a '
               'failover, a server that returns late, or a complete power cut:'))
    s += bullets([
        '**The topology follows a failover.** When Pgpool-II serves a new primary, the launcher redraws the '
        'replication links and rewrites the configuration files it can reach.',
        '**The role is persisted** in the `.env` of each node (by promote, redirect, rewind and the launcher), so every '
        'node restarts with the role it last had.',
        '**Old-primary guard.** At start, a node configured as primary asks the other nodes (`PEER_HOSTS`) for their '
        'timeline. If one is primary on a newer timeline, this node is an old primary: depending on *Settings → Old '
        'primary that comes back* it **rejoins automatically** (`pg_rewind`, or a fresh copy if that fails) or **waits** '
        'without starting. Unreachable peers are ignored, so a cluster where every node was down still starts.',
        '`detach_false_primary = on` in Pgpool-II: if two primaries run anyway, the one without streaming replicas is '
        'detached and writes only reach the real one.',
        '**Auto-heal** (*Settings*, on by default): the launcher rejoins old primaries and re-attaches healthy nodes '
        'that Pgpool-II keeps detached; a standby Pgpool-II out of sync with the watchdog leader is restarted to copy '
        "the leader's view. One action at a time, at most once every two minutes per node.",
        '**Stop means stop.** A replica stopped from the launcher stays stopped: Pgpool-II no longer restarts it through '
        'its failover recovery.',
        '**Missing configuration is restored.** If the configuration of a node vanished from its server, *Start* writes '
        'it again before starting the container.',
    ])
    s += figure('76-settings', 'Figure 7.4 - Settings: what an old primary does when it comes back, and auto-heal.',
                max_height=300)
    s += table([
        ['Situation', 'What happens', 'Measured'],
        ['The server of the primary goes down', 'Pgpool-II promotes a replica; the drawing follows.', 'new primary in ~22 s'],
        ['That server comes back', 'The old primary rejoins as a replica (pg_rewind); auto-heal attaches it.',
         'replica 6 s after power-on, attached 3 s later'],
        ['Every server goes down and comes back', 'Each node starts with its recorded role; replicas stream again.',
         'usable 18 s after power-on'],
        ['Pgpool-II keeps a healthy node detached', 'Auto-heal attaches it.', '3-8 s'],
    ], widths=[30, 52, 28])
    s.append(P('What cannot be recovered automatically: two primaries that both accepted writes (clients that bypassed '
               'Pgpool-II), and the loss of the disks of every node. PgCloud has no scheduled backups or WAL archiving '
               'yet; keep backups outside the cluster (for example pgBackRest).'))

    # ------------------------------------------------------------------ 7.3
    s += H(2, '7.3', 'Fast-swap')
    s.append(P('When the cluster is about to lose its data (only one PostgreSQL node with data is still running, or the '
               'primary has no replica or backup streaming from it) a red **CLUSTER AT RISK** banner appears on every '
               'tab with a **Fast-swap** button. Give it the SSH access of a new server: the launcher picks the node with '
               'the freshest data (the primary Pgpool-II serves, or the highest timeline and WAL position) and copies it '
               'with **pg_basebackup over streaming replication**.'))
    s.append(P('That is faster and safer than copying files: an `scp` of a running data directory is inconsistent, '
               'while pg_basebackup copies only the database, keeps the source running and leaves the new node '
               'streaming, so nothing written during the copy is lost. The node is created as a top-priority backup '
               '(priority 1000, grace 30 s), so the backup logic can use it at once. Fast-swap nodes may stream from a '
               'replica when no primary is left.'))

    # ------------------------------------------------------------------ 7.4
    s += H(2, '7.4', 'The "System not accessible" alert')
    s.append(P('When no entry point accepts connections for more than 6 seconds (the PgBouncer nodes, or the '
               'Pgpool-II nodes if there is no PgBouncer, or the primary if there is neither) a red card appears in '
               'the bottom-right corner of every tab. It says for how long the system has been unreachable, why '
               '(checked layer by layer) and what can be done, with an **Apply** button when the launcher can do it:'))
    s += table([
        ['Situation', 'Offered'],
        ['No PostgreSQL node deployed', 'Deploy the cluster'],
        ['No PostgreSQL node running', 'Start each node; restore from a backup'],
        ['Replicas running but no primary', 'Promote the node with the freshest data (a backup is never offered: '
         'a last-resort backup about to take over is shown as AUTO)'],
        ['A second primary', 'Rejoin it as a replica'],
        ['Pgpool-II unreachable or refusing connections', 'Re-attach detached nodes; redeploy every Pgpool-II node'],
        ['PgBouncer down', 'Restart it'],
        ['Last copy of the data at risk', 'Fast-swap'],
        ['Always', 'Check network, firewall, disk and Docker; Destroy & rebuild as a last resort'],
    ], widths=[40, 70])
    s.append(P('While an operation runs the card says so: the entry point may simply be paused. `GET /api/access` '
               'returns the same diagnosis.'))

    # ------------------------------------------------------------------ 7.5
    s += H(2, '7.5', 'Audit recordings')
    s.append(P('The **REC** button in the top bar starts a recording; press it again to stop. The launcher then '
               'collects everything that happened in that window into one timeline, with date and time: its events, '
               'every operation with its console, the container logs of every node and the Pgpool-II failover and '
               'failback logs.'))
    s += figure('72-header-rec', 'Figure 7.5 - The REC button in the top bar.', max_height=40)
    s += figure('75-audit', 'Figure 7.6 - Audit tab: a recording of 2,870 entries, filtered by text, level, node and '
                'source, downloadable as .log or .json.', max_height=300)

    # ------------------------------------------------------------------ 7.6
    s += H(2, '7.6', 'Destroy & rebuild cluster')
    s.append(P('For a cluster beyond repair or a test environment: *Deploy tab → Danger zone*. After typing `DESTROY` '
               'it deletes every container, PostgreSQL data volume and configuration directory of every node, then '
               'deploys the cluster again from the drawing with empty databases. It cannot be undone.'))
    s += figure('77-danger-zone', 'Figure 7.7 - Danger zone of the Deploy tab.', max_height=120)

    # ------------------------------------------------------------------ 7.7
    s += H(2, '7.7', 'Tests of 1.2.0')
    s.append(P('Run on the launcher playground: five Docker-in-Docker servers, three Pgpool-II nodes, three PostgreSQL '
               'nodes and two backups (grace time 60 s unless stated). Times are taken from the launcher events.'))
    s += table([
        ['#', 'Test', 'Result'],
        ['40', 'Stop a replica (pg1) with a backup ready', 'It stays down. The backup takes its place 62 s later and '
         'Pgpool-II serves it 36 s after that.'],
        ['41', 'Start the replaced node again', 'Healthy for 60 s, then the backup hands the work back; it is a backup '
         'again 35 s later. Repeated three times with the same result.'],
        ['42', '"Return to backup" off', 'The backup replaced pg2 and became a system node (EX-BACKUP); pg2 became the '
         'backup.'],
        ['43', 'Every normal PostgreSQL node down', 'The backup is promoted after the grace time (63 s) and serves as '
         'the primary 33 s later.'],
        ['44', 'The nodes come back after a last resort', '55 s after they started, the backup hands the primary role '
         'back with a switchover (51 s); it is a backup again 2 min later.'],
        ['45', 'Switchover or promote to a backup', 'Refused by the interface and the API.'],
        ['46', 'Full outage, every node down, then started', 'Every node starts (the old-primary guard ignores the '
         'unreachable peers); usable 18 s after power-on.'],
        ['47', 'Configuration of the nodes deleted from the servers', 'Start writes it again and starts the node.'],
        ['48', 'Fast-swap to a new server', 'Consistent copy by streaming; the new node keeps streaming.'],
        ['49', 'No entry point reachable', 'The alert appears after 6 s with the cause and the fixes.'],
        ['50', 'Audit recording during the backup tests', '2,870 entries collected from every node; .log and .json '
         'downloads.'],
    ], widths=[6, 38, 66])

    # ------------------------------------------------------------------ 7.8
    s += H(2, '7.8', 'Upgrading from 1.1.0')
    s += bullets([
        'Pull or build the 1.2.0 images and the 1.2.0 launcher (`zhenglinlei/pgcloud-launcher:1.2.0`), keeping its '
        '`/data` volume.',
        '**Redeploy the PostgreSQL nodes** (one at a time; the data is kept) to get the new start-up guard: it is what '
        'lets a cluster start after a full outage.',
        '**Redeploy the Pgpool-II nodes** (the launcher redeploys them all together) for `detach_false_primary` and for '
        '*Stop* to stick.',
        'Review *Settings → Old primary that comes back* and *Auto-heal*; add backup nodes if you have spare servers.',
    ], numbered=True)
    s.append(code('''$ docker pull zhenglinlei/pgcloud-launcher:1.2.0
$ docker rm -f pgcloud-launcher
$ docker run -d --name pgcloud-launcher -p 8080:8080 \\
    -v pgcloud-launcher:/data zhenglinlei/pgcloud-launcher:1.2.0'''))

    # ------------------------------------------------------------------ 7.9
    s += H(2, '7.9', 'Known limitations of 1.2.0')
    s += bullets([
        'A backup refuses no direct connection: a client connected straight to its port 5432 can read (it is a hot '
        'standby). Only the entry points keep traffic away from it.',
        'No scheduled backups or WAL archiving: losing the disks of every node loses the data.',
        'Two nodes that both believe they are the primary and start at exactly the same moment cannot see each other at '
        'start; `detach_false_primary` and auto-heal resolve it right after.',
        'TLS between nodes is not enabled; use a private network or a VPN.',
    ])
    s.append(Spacer(1, 6))
    return s
