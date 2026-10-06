/*
 * Leitor de arquivos do LibreOffice / OpenDocument (ODF)
 * Suporta: .odt .ott .fodt (texto) | .ods .ots .fods (planilha) |
 *          .odp .otp .fodp (apresentação) | .odg .otg .fodg (desenho) | .sxw .sxc .sxi
 * Converte para HTML (montado via DOM, sem innerHTML de texto do arquivo),
 * separando as PÁGINAS / PLANILHAS / SLIDES em blocos visíveis.
 *
 * Uso: const el = await OdfReader.render(arrayBuffer, '.odt');  // devolve um <div>
 */
(function (root) {
    'use strict';

    var NS = {
        office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
        text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
        table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
        draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
        style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
        fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
        xlink: 'http://www.w3.org/1999/xlink',
        svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0'
    };

    var MAX_COLS = 60, MAX_ROWS = 3000;

    // ---------- utilidades ----------
    function ln(n) { return n.localName; }
    function isEl(n) { return n && n.nodeType === 1; }
    function attr(el, ns, name) {
        if (!el) return null;
        var v = el.getAttributeNS(NS[ns], name);
        return (v === '' || v === null) ? null : v;
    }
    function kids(el) { return Array.prototype.slice.call(el.childNodes); }
    function firstChild(el, ns, name) {
        for (var c = el.firstChild; c; c = c.nextSibling) {
            if (isEl(c) && c.namespaceURI === NS[ns] && ln(c) === name) return c;
        }
        return null;
    }
    function childrenNamed(el, ns, name) {
        var out = [];
        for (var c = el.firstChild; c; c = c.nextSibling) {
            if (isEl(c) && c.namespaceURI === NS[ns] && ln(c) === name) out.push(c);
        }
        return out;
    }
    function lenToPx(v) {
        if (!v) return null;
        var m = /^(-?[\d.]+)(cm|mm|in|pt|px|%)?$/.exec(String(v).trim());
        if (!m) return null;
        var n = parseFloat(m[1]);
        switch (m[2]) {
            case 'cm': return n * 37.795;
            case 'mm': return n * 3.7795;
            case 'in': return n * 96;
            case 'pt': return n * 1.3333;
            case 'px': return n;
            default: return null;
        }
    }

    // ---------- estilos ----------
    function collectStyles(docs) {
        var styles = {};
        docs.forEach(function (doc) {
            if (!doc) return;
            var all = doc.getElementsByTagNameNS(NS.style, 'style');
            for (var i = 0; i < all.length; i++) {
                var st = all[i];
                var name = attr(st, 'style', 'name');
                if (!name) continue;
                var fam = attr(st, 'style', 'family') || '';
                styles[fam + ':' + name] = st;
            }
        });
        return styles;
    }

    function styleChain(styles, fam, name) {
        var chain = [], guard = 0;
        while (name && guard++ < 12) {
            var st = styles[fam + ':' + name];
            if (!st) break;
            chain.unshift(st);
            name = attr(st, 'style', 'parent-style-name');
        }
        return chain;
    }

    function resolveStyle(styles, fam, name) {
        var res = { css: {}, breakBefore: false, breakAfter: false, masterPage: null };
        styleChain(styles, fam, name).forEach(function (st) {
            var mp = attr(st, 'style', 'master-page-name');
            if (mp) res.masterPage = mp;
            var tp = firstChild(st, 'style', 'text-properties');
            if (tp) {
                var fw = attr(tp, 'fo', 'font-weight');
                if (fw) res.css['font-weight'] = (fw === 'bold' || parseInt(fw, 10) >= 600) ? '700' : '400';
                var fs = attr(tp, 'fo', 'font-style');
                if (fs) res.css['font-style'] = (fs === 'italic' || fs === 'oblique') ? 'italic' : 'normal';
                var deco = [];
                var us = attr(tp, 'style', 'text-underline-style');
                if (us && us !== 'none') deco.push('underline');
                var ls = attr(tp, 'style', 'text-line-through-style');
                if (ls && ls !== 'none') deco.push('line-through');
                if (us === 'none' && ls === 'none') res.css['text-decoration'] = 'none';
                else if (deco.length) res.css['text-decoration'] = deco.join(' ');
                var col = attr(tp, 'fo', 'color');
                if (col && /^#[0-9a-f]{3,8}$/i.test(col)) res.css['color'] = col;
                var bg = attr(tp, 'fo', 'background-color');
                if (bg && /^#[0-9a-f]{3,8}$/i.test(bg)) res.css['background-color'] = bg;
                var fsz = attr(tp, 'fo', 'font-size');
                if (fsz && /pt$/.test(fsz)) res.css['font-size'] = fsz;
                var pos = attr(tp, 'style', 'text-position');
                if (pos) {
                    if (/^sub|^-/.test(pos)) { res.css['vertical-align'] = 'sub'; res.css['font-size'] = '0.75em'; }
                    else if (/^super|^\d/.test(pos)) { res.css['vertical-align'] = 'super'; res.css['font-size'] = '0.75em'; }
                }
                var tt = attr(tp, 'fo', 'text-transform');
                if (tt && /uppercase|lowercase|capitalize/.test(tt)) res.css['text-transform'] = tt;
                var fv = attr(tp, 'fo', 'font-variant');
                if (fv === 'small-caps') res.css['font-variant'] = 'small-caps';
            }
            var pp = firstChild(st, 'style', 'paragraph-properties');
            if (pp) {
                var ta = attr(pp, 'fo', 'text-align');
                if (ta) {
                    var map = { start: 'left', end: 'right', left: 'left', right: 'right', center: 'center', justify: 'justify' };
                    if (map[ta]) res.css['text-align'] = map[ta];
                }
                var ml = lenToPx(attr(pp, 'fo', 'margin-left'));
                if (ml !== null) res.css['margin-left'] = Math.max(0, Math.round(ml)) + 'px';
                var ti = lenToPx(attr(pp, 'fo', 'text-indent'));
                if (ti !== null) res.css['text-indent'] = Math.round(ti) + 'px';
                var mt = lenToPx(attr(pp, 'fo', 'margin-top'));
                if (mt !== null) res.css['margin-top'] = Math.min(60, Math.max(0, Math.round(mt))) + 'px';
                var mb = lenToPx(attr(pp, 'fo', 'margin-bottom'));
                if (mb !== null) res.css['margin-bottom'] = Math.min(60, Math.max(0, Math.round(mb))) + 'px';
                var bb = attr(pp, 'fo', 'break-before');
                if (bb) res.breakBefore = (bb === 'page');
                var ba = attr(pp, 'fo', 'break-after');
                if (ba) res.breakAfter = (ba === 'page');
            }
            var tbp = firstChild(st, 'style', 'table-properties');
            if (tbp) {
                var tbb = attr(tbp, 'fo', 'break-before');
                if (tbb) res.breakBefore = (tbb === 'page');
                var tba = attr(tbp, 'fo', 'break-after');
                if (tba) res.breakAfter = (tba === 'page');
            }
            var tcp = firstChild(st, 'style', 'table-cell-properties');
            if (tcp) {
                var cbg = attr(tcp, 'fo', 'background-color');
                if (cbg && /^#[0-9a-f]{3,8}$/i.test(cbg)) res.css['background-color'] = cbg;
                var vb = attr(tcp, 'style', 'vertical-align');
                if (vb && /^(top|middle|bottom)$/.test(vb)) res.css['vertical-align'] = vb;
            }
        });
        return res;
    }

    function applyCss(el, css) {
        for (var k in css) { if (css.hasOwnProperty(k)) el.style.setProperty(k, css[k]); }
    }

    // ---------- conversor ----------
    function Converter(styles, images) {
        this.styles = styles;
        this.images = images || {};
        this.listStyleNumbered = {};
        this.pageBreakPending = false;
        this.firstBlock = true;
        this.footnotes = [];
        this.pages = [];           // lista de <div class="odf-page">
        this.cur = null;
        this.newPage();
    }

    Converter.prototype.newPage = function () {
        if (this.cur && !this.cur.childNodes.length) return; // evita páginas vazias
        var p = document.createElement('div');
        p.className = 'odf-page';
        this.pages.push(p);
        this.cur = p;
    };

    Converter.prototype.maybeBreak = function (style) {
        // quebra de página explícita (antes) ou troca de estilo de página (master-page)
        if (style && (style.breakBefore || (style.masterPage && !this.firstBlock))) {
            this.newPage();
        }
        this.firstBlock = false;
    };

    Converter.prototype.afterBlock = function (style) {
        if (style && style.breakAfter) this.newPage();
    };

    Converter.prototype.isNumberedList = function (name) {
        if (!name) return false;
        return !!this.listStyleNumbered[name];
    };

    Converter.prototype.blocks = function (parent, target) {
        var self = this;
        kids(parent).forEach(function (n) {
            if (!isEl(n)) return;
            var t = ln(n), ns = n.namespaceURI;
            if (ns === NS.text) {
                if (t === 'p' || t === 'h') self.paragraph(n, target);
                else if (t === 'list') self.list(n, target);
                else if (t === 'table-of-content' || t === 'illustration-index' || t === 'alphabetical-index' ||
                         t === 'user-index' || t === 'bibliography' || t === 'index-body' || t === 'section' ||
                         t === 'index-title' || t === 'table-index' || t === 'object-index') {
                    self.blocks(n, target);
                }
            } else if (ns === NS.table && t === 'table') {
                self.table(n, target);
            } else if (ns === NS.draw && (t === 'frame' || t === 'custom-shape' || t === 'g' || t === 'rect' || t === 'text-box')) {
                self.frame(n, target);
            }
        });
    };

    Converter.prototype.paragraph = function (p, target) {
        var t = ln(p);
        var sname = attr(p, 'text', 'style-name');
        var style = resolveStyle(this.styles, 'paragraph', sname);
        var top = !target;
        if (top) { this.maybeBreak(style); target = this.cur; }

        var tag = 'p';
        if (t === 'h') {
            var lvl = parseInt(attr(p, 'text', 'outline-level') || '1', 10);
            tag = 'h' + Math.min(6, Math.max(1, lvl));
        }
        var el = document.createElement(tag);
        applyCss(el, style.css);
        el.style.whiteSpace = 'pre-wrap';
        this.inline(p, el);
        if (!el.childNodes.length) el.appendChild(document.createElement('br'));
        target.appendChild(el);
        if (top) this.afterBlock(style);
    };

    Converter.prototype.list = function (l, target) {
        target = target || this.cur;
        var lstyle = attr(l, 'text', 'style-name');
        var numbered = this.isNumberedList(lstyle);
        var ul = document.createElement(numbered ? 'ol' : 'ul');
        var self = this;
        childrenNamed(l, 'text', 'list-header').concat(childrenNamed(l, 'text', 'list-item')).forEach(function (li) {
            var item = document.createElement('li');
            kids(li).forEach(function (c) {
                if (!isEl(c)) return;
                if (c.namespaceURI === NS.text && (ln(c) === 'p' || ln(c) === 'h')) {
                    var holder = document.createElement('div');
                    self.paragraphInto(c, holder);
                    while (holder.firstChild) item.appendChild(holder.firstChild);
                } else if (c.namespaceURI === NS.text && ln(c) === 'list') {
                    self.list(c, item);
                }
            });
            ul.appendChild(item);
        });
        target.appendChild(ul);
    };

    // parágrafo dentro de lista/célula: sem quebra de página
    Converter.prototype.paragraphInto = function (p, target) {
        var style = resolveStyle(this.styles, 'paragraph', attr(p, 'text', 'style-name'));
        var el = document.createElement(ln(p) === 'h' ? 'h4' : 'p');
        applyCss(el, style.css);
        el.style.whiteSpace = 'pre-wrap';
        el.style.margin = '0 0 0.3em';
        this.inline(p, el);
        if (!el.childNodes.length) el.appendChild(document.createElement('br'));
        target.appendChild(el);
    };

    Converter.prototype.inline = function (node, out) {
        var self = this;
        kids(node).forEach(function (n) {
            if (n.nodeType === 3) {
                out.appendChild(document.createTextNode(n.nodeValue.replace(/[\r\n\t]+/g, ' ')));
                return;
            }
            if (!isEl(n)) return;
            var t = ln(n), ns = n.namespaceURI;
            if (ns === NS.text) {
                if (t === 's') {
                    var c = parseInt(attr(n, 'text', 'c') || '1', 10);
                    out.appendChild(document.createTextNode(new Array(Math.min(c, 400) + 1).join('\u00a0')));
                } else if (t === 'tab') {
                    out.appendChild(document.createTextNode('\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0'));
                } else if (t === 'line-break') {
                    out.appendChild(document.createElement('br'));
                } else if (t === 'span') {
                    var sp = document.createElement('span');
                    applyCss(sp, resolveStyle(self.styles, 'text', attr(n, 'text', 'style-name')).css);
                    self.inline(n, sp);
                    out.appendChild(sp);
                } else if (t === 'a') {
                    var a = document.createElement('span');
                    a.style.color = '#2563eb';
                    a.style.textDecoration = 'underline';
                    self.inline(n, a);
                    out.appendChild(a);
                } else if (t === 'note') {
                    var num = self.footnotes.length + 1;
                    var body = firstChild(n, 'text', 'note-body');
                    var sup = document.createElement('sup');
                    sup.textContent = '[' + num + ']';
                    out.appendChild(sup);
                    var fn = document.createElement('div');
                    fn.className = 'odf-footnote';
                    fn.appendChild(document.createTextNode('[' + num + '] '));
                    if (body) kids(body).forEach(function (b) { if (isEl(b)) self.inline(b, fn); });
                    self.footnotes.push(fn);
                } else if (t === 'soft-page-break' || t === 'bookmark' || t === 'bookmark-start' ||
                           t === 'bookmark-end' || t === 'reference-mark' || t === 'change' ||
                           t === 'change-start' || t === 'change-end' || t === 'note-citation') {
                    // ignorados
                } else if (t === 'tracked-changes') {
                    // ignorado
                } else {
                    self.inline(n, out); // campos (número de página, data...) e outros: mostra o texto
                }
            } else if (ns === NS.draw) {
                self.frame(n, out, true);
            } else if (ns === NS.office && t === 'annotation') {
                // comentários: ignorados
            }
        });
    };

    Converter.prototype.frame = function (n, target, inlineMode) {
        var self = this;
        target = target || this.cur;
        var t = ln(n);
        if (t === 'image') {
            self.imageEl(n, target);
            return;
        }
        if (t === 'frame' || t === 'g' || t === 'custom-shape' || t === 'rect') {
            kids(n).forEach(function (c) {
                if (!isEl(c)) return;
                var ct = ln(c);
                if (ct === 'image') self.imageEl(c, target);
                else if (ct === 'text-box') {
                    var box = document.createElement('div');
                    box.className = 'odf-textbox';
                    self.blocks(c, box);
                    if (box.childNodes.length) target.appendChild(box);
                } else if (ct === 'frame' || ct === 'g') self.frame(c, target, inlineMode);
                else if (c.namespaceURI === NS.text && (ct === 'p' || ct === 'h')) self.paragraphInto(c, target);
                else if (c.namespaceURI === NS.text && ct === 'list') self.list(c, target);
            });
        } else if (t === 'text-box') {
            var box2 = document.createElement('div');
            box2.className = 'odf-textbox';
            self.blocks(n, box2);
            if (box2.childNodes.length) target.appendChild(box2);
        }
    };

    Converter.prototype.imageEl = function (n, target) {
        target = target || this.cur;
        var href = attr(n, 'xlink', 'href');
        if (!href) return;
        var src = this.images[href];
        if (!src) return;
        var img = document.createElement('img');
        img.src = src;
        img.alt = '';
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.display = 'block';
        img.style.margin = '6px auto';
        target.appendChild(img);
    };

    Converter.prototype.table = function (tbl, target) {
        var self = this;
        var style = resolveStyle(this.styles, 'table', attr(tbl, 'table', 'style-name'));
        var topT = !target;
        if (topT) { this.maybeBreak(style); target = this.cur; }

        var table = document.createElement('table');
        table.className = 'odf-table';
        var tbody = document.createElement('tbody');
        table.appendChild(tbody);

        var rowCount = 0;
        var walkRows = function (parent) {
            kids(parent).forEach(function (r) {
                if (!isEl(r) || r.namespaceURI !== NS.table) return;
                var rt = ln(r);
                if (rt === 'table-header-rows' || rt === 'table-row-group' || rt === 'table-rows') { walkRows(r); return; }
                if (rt !== 'table-row') return;
                var rep = Math.min(parseInt(attr(r, 'table', 'number-rows-repeated') || '1', 10), 50);
                for (var k = 0; k < rep; k++) {
                    if (rowCount >= MAX_ROWS) return;
                    var tr = document.createElement('tr');
                    var colCount = 0, hasContent = false;
                    kids(r).forEach(function (c) {
                        if (!isEl(c) || c.namespaceURI !== NS.table) return;
                        var ct = ln(c);
                        if (ct !== 'table-cell' && ct !== 'covered-table-cell') return;
                        var crep = Math.min(parseInt(attr(c, 'table', 'number-columns-repeated') || '1', 10), MAX_COLS);
                        for (var j = 0; j < crep; j++) {
                            if (colCount >= MAX_COLS) break;
                            colCount++;
                            if (ct === 'covered-table-cell') continue;
                            var td = document.createElement('td');
                            var cs = parseInt(attr(c, 'table', 'number-columns-spanned') || '1', 10);
                            var rs = parseInt(attr(c, 'table', 'number-rows-spanned') || '1', 10);
                            if (cs > 1) td.colSpan = cs;
                            if (rs > 1) td.rowSpan = rs;
                            var cst = resolveStyle(self.styles, 'table-cell', attr(c, 'table', 'style-name'));
                            applyCss(td, cst.css);
                            var holder = td;
                            kids(c).forEach(function (cc) {
                                if (!isEl(cc)) return;
                                if (cc.namespaceURI === NS.text && (ln(cc) === 'p' || ln(cc) === 'h')) self.paragraphInto(cc, holder);
                                else if (cc.namespaceURI === NS.text && ln(cc) === 'list') self.list(cc, holder);
                                else if (cc.namespaceURI === NS.table && ln(cc) === 'table') self.table(cc, holder);
                                else if (cc.namespaceURI === NS.draw) self.frame(cc, holder);
                            });
                            if (td.textContent.trim() || td.querySelector('img')) hasContent = true;
                            tr.appendChild(td);
                        }
                    });
                    if (hasContent || (rep === 1 && tr.childNodes.length)) { tbody.appendChild(tr); rowCount++; }
                }
            });
        };
        walkRows(tbl);

        if (tbody.childNodes.length) {
            var wrap = document.createElement('div');
            wrap.className = 'odf-table-wrap';
            wrap.appendChild(table);
            target.appendChild(wrap);
        }
        if (topT) this.afterBlock(style);
    };

    // ---------- carregamento ----------
    function parseXml(text) {
        var doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) throw new Error('Arquivo XML inválido.');
        return doc;
    }

    function mimeFromName(name) {
        var e = String(name).toLowerCase().split('.').pop();
        return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' })[e] || null;
    }

    async function loadFromZip(buffer) {
        if (!root.JSZip) throw new Error('Biblioteca JSZip não carregada.');
        var zip = await root.JSZip.loadAsync(buffer);
        var contentFile = zip.file('content.xml');
        if (!contentFile) throw new Error('content.xml não encontrado: arquivo não parece ser do LibreOffice.');
        var content = parseXml(await contentFile.async('string'));
        var stylesFile = zip.file('styles.xml');
        var stylesDoc = stylesFile ? parseXml(await stylesFile.async('string')) : null;

        // imagens
        var images = {};
        var imgNodes = content.getElementsByTagNameNS(NS.draw, 'image');
        var hrefs = {};
        for (var i = 0; i < imgNodes.length; i++) {
            var h = attr(imgNodes[i], 'xlink', 'href');
            if (h && !/^(https?:|data:)/i.test(h)) hrefs[h] = true;
        }
        var names = Object.keys(hrefs);
        for (var k = 0; k < names.length; k++) {
            var f = zip.file(names[k].replace(/^\.\//, ''));
            var mime = mimeFromName(names[k]);
            if (f && mime) {
                try { images[names[k]] = 'data:' + mime + ';base64,' + await f.async('base64'); } catch (e) { }
            }
        }
        return { content: content, styles: stylesDoc, images: images };
    }

    async function loadFlat(buffer) {
        var text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
        var doc = parseXml(text);
        var images = {};
        var imgNodes = doc.getElementsByTagNameNS(NS.draw, 'image');
        for (var i = 0; i < imgNodes.length; i++) {
            var bin = firstChild(imgNodes[i], 'office', 'binary-data');
            var h = attr(imgNodes[i], 'xlink', 'href') || ('flat-' + i);
            if (bin) {
                images[h] = 'data:image/png;base64,' + bin.textContent.replace(/\s+/g, '');
                imgNodes[i].setAttributeNS(NS.xlink, 'xlink:href', h);
            }
        }
        return { content: doc, styles: doc, images: images };
    }

    function isZip(buffer) {
        var b = new Uint8Array(buffer, 0, 4);
        return b[0] === 0x50 && b[1] === 0x4b;
    }

    function markNumberedLists(docs, conv) {
        docs.forEach(function (doc) {
            if (!doc) return;
            var ls = doc.getElementsByTagNameNS(NS.text, 'list-style');
            for (var i = 0; i < ls.length; i++) {
                var name = attr(ls[i], 'style', 'name');
                if (!name) continue;
                var first = ls[i].firstElementChild;
                if (first && ln(first) === 'list-level-style-number') conv.listStyleNumbered[name] = true;
            }
        });
    }

    function badge(text) {
        var h = document.createElement('div');
        h.className = 'odf-label';
        h.textContent = text;
        return h;
    }

    function renderText(body, conv) {
        conv.blocks(body, null);
        var pages = conv.pages.filter(function (p) { return p.childNodes.length; });
        if (conv.footnotes.length && pages.length) {
            var last = pages[pages.length - 1];
            var hr = document.createElement('hr');
            last.appendChild(hr);
            conv.footnotes.forEach(function (f) { last.appendChild(f); });
        }
        return pages;
    }

    function renderSpreadsheet(body, conv) {
        var pages = [];
        var tables = childrenNamed(body, 'table', 'table');
        tables.forEach(function (t, idx) {
            var page = document.createElement('div');
            page.className = 'odf-page odf-sheet';
            page.appendChild(badge('Planilha ' + (idx + 1) + ': ' + (attr(t, 'table', 'name') || '')));
            conv.table(t, page);
            if (page.querySelector('table')) pages.push(page);
        });
        return pages;
    }

    function renderPresentation(body, conv) {
        var pages = [];
        var slides = childrenNamed(body, 'draw', 'page');
        slides.forEach(function (s, idx) {
            var page = document.createElement('div');
            page.className = 'odf-page odf-slide';
            page.appendChild(badge((ln(body) === 'drawing' ? 'Página ' : 'Slide ') + (idx + 1) +
                (attr(s, 'draw', 'name') ? ': ' + attr(s, 'draw', 'name') : '')));
            kids(s).forEach(function (c) {
                if (!isEl(c)) return;
                if (c.namespaceURI === NS.draw) conv.frame(c, page);
                else if (c.namespaceURI === NS.table && ln(c) === 'table') conv.table(c, page);
            });
            pages.push(page);
        });
        return pages;
    }

    var OdfReader = {
        EXTENSOES: ['.odt', '.ott', '.fodt', '.ods', '.ots', '.fods', '.odp', '.otp', '.fodp',
                    '.odg', '.otg', '.fodg', '.sxw', '.stw', '.sxc', '.stc', '.sxi', '.sti', '.sxd'],

        render: async function (buffer, ext) {
            var data = isZip(buffer) ? await loadFromZip(buffer) : await loadFlat(buffer);
            var styles = collectStyles([data.styles, data.content]);
            var conv = new Converter(styles, data.images);
            markNumberedLists([data.styles, data.content], conv);

            var officeBody = data.content.getElementsByTagNameNS(NS.office, 'body')[0];
            if (!officeBody) throw new Error('Corpo do documento não encontrado.');
            var inner = null;
            for (var c = officeBody.firstChild; c; c = c.nextSibling) { if (isEl(c)) { inner = c; break; } }
            if (!inner) throw new Error('Documento vazio.');

            var pages;
            switch (ln(inner)) {
                case 'spreadsheet': pages = renderSpreadsheet(inner, conv); break;
                case 'presentation':
                case 'drawing': pages = renderPresentation(inner, conv); break;
                default: pages = renderText(inner, conv);
            }

            var wrap = document.createElement('div');
            wrap.className = 'odf-doc';
            pages.forEach(function (p, i) {
                if (pages.length > 1) {
                    var n = document.createElement('div');
                    n.className = 'odf-page-num';
                    n.textContent = 'Página ' + (i + 1) + ' de ' + pages.length;
                    p.appendChild(n);
                }
                wrap.appendChild(p);
            });
            if (!pages.length) {
                var empty = document.createElement('div');
                empty.className = 'odf-page';
                empty.textContent = 'O documento não possui conteúdo visualizável.';
                wrap.appendChild(empty);
            }
            return wrap;
        }
    };

    root.OdfReader = OdfReader;
})(window);
