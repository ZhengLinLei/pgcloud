<br><br>
<h5 align="center" style="font-family: monospace;">PgCloud</h5>
<br>
<p align="center">
    <img src="doc/img/pgcloud_small_logo_bgWhite_rounded.png" width="80px">
</p>
<br><br>

<!-- End Header -->

<p align="center">
    <q><b><i>&nbsp;Such as k8s but more beautiful.&nbsp;</i></b></q>
</p>
<br><br>
<p align="center">
    <a href="./CONTRIBUTING.md">Contributing</a>
    ·
    <a href="https://github.com/ZhengLinLei/pgcloud/issues">Issues</a>
    ·
    <a href="https://github.com/ZhengLinLei/pgcloud/wiki">Wiki</a>
    ·
    <a href="./doc/wiki">Book</a>
</p>
<br>
<p align="center">
    <a href="https://www.gnu.org/licenses/gpl-3.0.html">
        <img src="https://img.shields.io/badge/License-GPL%203.o-blue.svg" alt="License" />
    </a>
    &emsp;    
    <a>
        <img src="https://img.shields.io/badge/version-0.1.0-brightgreen" alt="Version" />
    </a>
</p>
<br>
<hr>
<br>

## 🧐  What is PgCloud?

<p align="justify" style="font-family: monospace;">
    PgCloud is an <code>automatic system</code> for generating distributed nodes of PostgreSQL, PgPool and PgBouncer without the need to remain on a physical machine, since it uses docker technology. The system is capable of generating Postgres nodes with database replication on the same or different machines, load balancing with PgPool and connection caching with PgBouncer.
</p> 

<br><br>
## 📁  What does PgCloud have?
<p align="justify" style="font-family: monospace;">
    There are several architectures offered by PgCloud tested perfectly by our team. There is even the possibility of customising the architecture with some extra configuration. The architecture is separated by layers, specifically three: <code>Replication Layer</code>, <code>Load Balancing Layer</code> and <code>Connection Pool Layer</code>.
</p>
<br>

### Three-tier architecture
<br>
<p align="justify" style="font-family: monospace;">
    <p align="center">
        <img align="center" src="doc/readme/1_three_layer_diagram.png" width="400px">
    </p>
    <br><br>
    <p align="justify">
        The <code>three-tier architecture</code> is the most used in environments where it requires much more data load and data consistency is prioritised, but its disadvantage is the time cost per request.
        <br>
        <blockquote>
            <b><i>NOTE:</i></b> Please note that there may be a bottleneck in PgBouncer if you do not place the nodes on machines with sufficient resources.
        </blockquote>
    </p>
</p>
<br>

### Two-tier architecture
<br>
<p align="justify" style="font-family: monospace;">
    <p align="center">
        <img align="center" src="doc/readme/2_two_layer_diagram.png" width="400px">
    </p>
    <br><br>
    <p align="justify">
        The other <code>two-tier architecture</code> is preferred for systems where time is prioritised, but the amount of load is low. It is also the fastest in preparing the cluster in case of a node failover. Since there is less communication and it is easier to reach a node agreement.
    </p>
</p>

<br><br><br>
By default the system is enabled to launch this architecture.

<br><br><br>
## 🔌  Diagram

<p align="justify">
    Each layer architecture has different conditions of nodes to occupy, below is an example of a complete architecture with connections. Each figure represents a node and not a physical machine, the decision of putting one or two different nodes in the same machine depends on the load and stability that is desired to give to the system.
</p>
<br>

### Two-tier diagram
<br>
<p align="center">
    <img src="doc/readme/3_three_layer_diagram.png" width="45%">
    <img src="doc/readme/4_three_layer_diagram.png" width="45%">
</p>
<p align="justify">
    <ul>
        <li>
            This is the most basic configuration that we can configure to offer load balancing. Its weakness is that it does not have a PgPool backup when a node goes down, the entire system stops receiving requests. Although it is undoubtedly the least expensive, optimal and simple for simple systems where it does not require much availability and load.
        </li>
        <br>
        <li>
            Creating a PgPool cluster alongside the PostgreSQL cluster helps to solve both the failover of a postgres node and a PgPool node. Throughout this documentation we will use primary and replica to map the postgres and master and slave roles for the PgPool cluster.
        </li>
    </ul>
</p>
<br>

### Three-tier diagram
<br>
<p align="center">
    <img src="doc/readme/5_two_layer_diagram.png" width="500px">
</p>
<p align="justify">
    With a three-tier architecture we have better consistency between nodes, this way if PgBouncer were to fail we could replace it with a PgPool gate, losing the capacity offered by PgBouncer but obtaining more availability. With this we are able to create a distributed system that offers load balancing and connection caching for fast management.
</p>
<br>

### Other architectures
<br>
<p align="justify">
    You can also use the system where you omit the load balancing layer, that is, use PgBouncer with Postgres. This architecture is not the most common but it does offer quite a few advantages if you only require these two modules.
</p>
<p align="center">
    <img src="doc/readme/6_two_layer_diagram_other.png" width="400px">
</p>
<p align="justify">
    PgBouncer is an optimal choice for efficiently pooling database connections, especially when your system needs connection caching rather than load balancing. Unlike PgPool, which offers additional features like load balancing, PgBouncer focuses solely on connection pooling. This makes it lightweight, with lower memory consumption and minimal configuration, ideal for handling high connection rates while maintaining a stable database environment.
    <br><br><br>
    An example using this layer is:
</p>
<p align="center">
    <img src="doc/readme/7_two_layer_diagram_other.png" width="400px">
</p>
<br><br><br><br><br><br><br>
<p align="center" style="font-family: monospace;">...</p>
<br><br>
<h5 align="center" style="font-family: monospace;">Read more in our official Wiki or Book</h5>
<br>
<p align="center">
    <a href="https://github.com/ZhengLinLei/pgcloud/wiki">Wiki</a>
    ·
    <a href="./doc/wiki">Book</a>
</p>
<br><br><br><br>

