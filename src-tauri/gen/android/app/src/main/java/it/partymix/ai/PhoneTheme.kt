package it.partymix.ai

import android.content.Context
import android.content.res.Configuration
import com.google.android.material.R as M
import com.google.android.material.color.DynamicColors
import com.google.android.material.color.MaterialColors
import org.json.JSONObject

/**
 * The phone's own colours for the page: light or dark as set on the phone and, from Android 12, the Material You
 * palette taken from the wallpaper. Without Material You only the light/dark choice is sent and the page keeps
 * the PartyMix pink.
 */
object PhoneTheme {
  private val TOKENS = linkedMapOf(
    "primary" to M.attr.colorPrimary, "on-primary" to M.attr.colorOnPrimary,
    "primary-container" to M.attr.colorPrimaryContainer, "on-primary-container" to M.attr.colorOnPrimaryContainer,
    "secondary-container" to M.attr.colorSecondaryContainer, "on-secondary-container" to M.attr.colorOnSecondaryContainer,
    "tertiary" to M.attr.colorTertiary, "tertiary-container" to M.attr.colorTertiaryContainer, "on-tertiary-container" to M.attr.colorOnTertiaryContainer,
    "error" to M.attr.colorError, "on-error" to M.attr.colorOnError,
    "error-container" to M.attr.colorErrorContainer, "on-error-container" to M.attr.colorOnErrorContainer,
    "surface" to M.attr.colorSurface, "surface-low" to M.attr.colorSurfaceContainerLow, "surface-c" to M.attr.colorSurfaceContainer,
    "surface-high" to M.attr.colorSurfaceContainerHigh, "surface-highest" to M.attr.colorSurfaceContainerHighest,
    "on-surface" to M.attr.colorOnSurface, "on-surface-variant" to M.attr.colorOnSurfaceVariant,
    "outline" to M.attr.colorOutline, "outline-variant" to M.attr.colorOutlineVariant,
    "inverse-surface" to M.attr.colorSurfaceInverse, "inverse-on-surface" to M.attr.colorOnSurfaceInverse,
  )

  fun isDark(context: Context): Boolean =
    (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

  /** {"dark": true|false, "colors": {"primary": "#rrggbb", …}} — colors only with Material You. */
  fun json(context: Context): String {
    val out = JSONObject().put("dark", isDark(context))
    if (DynamicColors.isDynamicColorAvailable()) {
      val ctx = DynamicColors.wrapContextIfAvailable(context)
      val colors = JSONObject()
      for ((name, attr) in TOKENS) {
        val c = MaterialColors.getColor(ctx, attr, 0)
        if (c != 0) colors.put(name, String.format("#%06x", c and 0xffffff))
      }
      out.put("colors", colors)
    }
    return out.toString()
  }
}
