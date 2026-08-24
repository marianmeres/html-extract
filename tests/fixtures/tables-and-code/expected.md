# Benchmarks and snippets

## Rectangular table (must become GFM)

| Parser | Docs/s | Peak RSS |
| --- | --- | --- |
| linkedom | 1240 | 210 MB |
| parse5 | 980 | 260 MB |
| jsdom | 110 | 1.4 GB |

## Table with colspan (must degrade to HTML)

<table>
		<thead><tr><th colspan="2">Throughput</th><th>Notes</th></tr></thead>
		<tbody>
			<tr><td>cold</td><td>410</td><td>first run</td></tr>
			<tr><td>warm</td><td>1240</td><td>steady state</td></tr>
		</tbody>
	</table>

## Ragged table (must degrade to HTML)

<table>
		<tr><td>a</td><td>b</td><td>c</td></tr>
		<tr><td>d</td></tr>
	</table>

## Code

Indentation and blank lines inside `<pre>` must survive exactly:

```python
def parse(src):
    depth = 0

    for ch in src:
        if ch == "{":
            depth += 1   # two spaces before this comment

    return depth
```

A fence-widening case, because the snippet itself contains a fence:

````
Write it like this:

```
literal fence inside the block
```
````

Inline code with a backtick: ``a ` b``, and one with markdown in it: `*not emphasis*`.

## Escaping corners

A paragraph with \*asterisks\*, \_underscores\_, \[brackets\] and a stray backslash \\ in it.

\# Not a heading, and 1. not a list either.

A line\
broken by a br, then a rule:

---

> Quoted.
>
> > Nested quote.