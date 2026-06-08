// ==UserScript==
// @name         VinSolutions Auto-Dial (5075 line + Dial Customer)
// @namespace    dialer
// @version      1.0
// @description  On the VinSolutions LogCall page: force the outbound line to the
//               5075 number (-> Jake via the press-1 shim), then auto-click "Dial
//               Customer". Turns the campaign console's deep link into a one-click
//               live call. Install in Tampermonkey (or add as an extension content
//               script matched to LogCallV2.aspx*).
// @match        https://vinsolutions.app.coxautoinc.com/CarDashboard/Pages/LeadManagement/LogCallV2/LogCallV2.aspx*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  var WANT = '5075';            // last 4 of the correct outbound line (-> Jake)
  var numberSet = false, done = false, tries = 0;

  function selectNumber() {
    var jq = window.jQuery || window.$; if (!jq) return false;
    var w = jq('#AgentNumberComboBox').data('kendoComboBox')
         || jq('#AgentNumberComboBox').data('kendoDropDownList');
    if (!w) return false;
    var items = w.dataSource.data();
    for (var i = 0; i < items.length; i++) {
      var txt = w.options.dataTextField ? items[i][w.options.dataTextField] : String(items[i]);
      if (txt && String(txt).replace(/\D/g, '').indexOf(WANT) > -1) {
        if (w.select) w.select(i); else w.value(items[i][w.options.dataValueField]);
        w.trigger('change');
        return true;
      }
    }
    return false;
  }

  function dial() {
    var btn = document.querySelector('button[data-bind*="dialCustomer"]');
    if (btn && !btn.disabled) { btn.click(); return true; }
    return false;     // not there / still disabled -> keep waiting
  }

  var iv = setInterval(function () {
    if (++tries > 60) return clearInterval(iv);              // ~30s safety stop
    if (!numberSet) { numberSet = selectNumber(); return; }  // set # first, wait a tick
    if (!done && dial()) { done = true; clearInterval(iv); }
  }, 500);
})();
