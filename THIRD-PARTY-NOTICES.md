# Third-Party Notices

nodeterm is licensed under BUSL-1.1 (see `LICENSE`), and it is built on and bundles the
following open-source components. Each is the property of its respective authors
and is used under its own license. Their license terms are not affected by
nodeterm's license.

| Component | License |
| --- | --- |
| Electron | MIT |
| React, React DOM | MIT |
| @xyflow/react (React Flow) | MIT |
| @dagrejs/dagre, @dagrejs/graphlib | MIT |
| @xterm/xterm, @xterm/addon-fit | MIT |
| monaco-editor | MIT |
| @excalidraw/excalidraw (whiteboard node) | MIT |
| node-pty | MIT |
| marked | MIT |
| DOMPurify | Apache-2.0 OR MPL-2.0 |
| zustand | MIT |
| electron-updater, electron-builder | MIT |
| @anthropic-ai/claude-agent-sdk | © Anthropic PBC, proprietary (see the package's LICENSE.md) |
| ws | MIT |
| tweetnacl | Unlicense (public domain) |
| tmux (macOS builds only) | ISC |
| libevent (macOS builds only, linked statically into tmux) | BSD-3-Clause |
| utf8proc (macOS builds only, linked statically into tmux) | MIT |
| three (three.js), agent graph 3D view | MIT |
| 3d-force-graph, three-forcegraph, three-render-objects, d3-force-3d, d3-octree, d3-binarytree, kapsule, accessor-fn, data-bind-mapper, float-tooltip, agent graph 3D view | MIT |
| ngraph.graph, ngraph.forcelayout, ngraph.events, ngraph.random, agent graph 3D view | BSD-3-Clause (notice below) |
| ngraph.merge, polished, tinycolor2, @tweenjs/tween.js, preact, lodash-es, @babel/runtime, agent graph 3D view | MIT |
| d3-array, d3-color, d3-dispatch, d3-format, d3-interpolate, d3-quadtree, d3-scale, d3-scale-chromatic, d3-selection, d3-time, d3-time-format, d3-timer, internmap, agent graph 3D view | ISC |

Full license texts are available in each package's directory under
`node_modules/`, and from the projects' upstream repositories.

## Bundled tmux (macOS)

The macOS app ships a copy of [tmux](https://github.com/tmux/tmux) at
`nodeterm.app/Contents/Resources/bin/tmux`, statically linked against
[libevent](https://github.com/libevent/libevent) and
[utf8proc](https://github.com/JuliaStrings/utf8proc). It is used **only** when the
machine has no tmux of its own — a tmux found anywhere on the system takes
precedence — so that terminals keep their sessions across restarts. None of the
three projects is modified; `scripts/build-tmux.mjs` builds the pinned upstream
release tarballs unchanged. Their license texts are in `resources/licenses/`
(`tmux-COPYING.txt`, `libevent-LICENSE.txt`, `utf8proc-LICENSE.md`), refreshed
from the tarballs by that same script.

## Agent graph 3D view

The agent graph's 3D view bundles [three.js](https://github.com/mrdoob/three.js) and
[3d-force-graph](https://github.com/vasturiano/3d-force-graph) with the packages
they use, listed above, into a chunk the app loads only when that view opens. None
of them is modified. The WebGPU renderer of three.js is not bundled
(`src/renderer/components/graph/three-webgpu-stub.ts` stands in for it).

The ngraph packages are under the BSD 3-Clause license, which asks for this notice
in binary distributions:

    Copyright (c) 2013 - 2026, Andrei Kashcha (ngraph.graph)
    Copyright (c) 2013 - 2022, Andrei Kashcha (ngraph.forcelayout)
    Copyright (c) 2013-2025 Andrei Kashcha (ngraph.events)
    Copyright (c) 2013-2025, Andrei Kashcha (ngraph.random)
    All rights reserved.

    Redistribution and use in source and binary forms, with or without modification,
    are permitted provided that the following conditions are met:

      Redistributions of source code must retain the above copyright notice, this
      list of conditions and the following disclaimer.

      Redistributions in binary form must reproduce the above copyright notice, this
      list of conditions and the following disclaimer in the documentation and/or
      other materials provided with the distribution.

      Neither the name of the Andrei Kashcha nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
    ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
    WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
    DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
    ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
    (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
    LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
    ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
    (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
    SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Trademarks

"Claude" and "Claude Code" are trademarks of Anthropic, PBC. The Claude Code
icon (`src/renderer/assets/claude.svg`) is used to label the optional
Claude Code terminal preset. nodeterm is not affiliated with, sponsored by, or
endorsed by Anthropic.
