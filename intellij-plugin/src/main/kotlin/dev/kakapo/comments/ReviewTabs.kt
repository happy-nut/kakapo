package dev.kakapo.comments

/**
 * Every list a comment can be read in, as one table with no IDE in it so `npm run idea:review` can
 * check it rather than read it.
 *
 * 0.0.5 shipped a single list, "Archived", and the comment you had just written was therefore in no
 * list anywhere: the only way to read it again was to hover the gutter icon in the one file it was in.
 * A comment is open or archived and nothing else, so the table has to be the whole partition — that
 * is the property `ReviewCheck` asserts, and it is what a new state would fail.
 */
object ReviewTabs {

    data class Tab(val title: String, val empty: String, val holds: (Comment) -> Boolean)

    val OPEN = Tab(
        title = "Open",
        empty = "No open comments — ⌥⇧⌘/ writes one on the caret's line.",
        holds = { !it.addressed },
    )

    val ARCHIVED = Tab(
        title = "Archived",
        empty = "Nothing archived yet — ⌃⇧⌘/ copies the open comments and archives them.",
        holds = { it.addressed },
    )

    val all: List<Tab> = listOf(OPEN, ARCHIVED)

    /** Newest first, because the one you want to re-read is the one you just wrote. */
    fun of(tab: Tab, comments: List<Comment>): List<Comment> = comments.filter(tab.holds).asReversed()
}
