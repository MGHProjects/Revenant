# awesome-early-web

A reading list about the web we lost. (Sample document for Revenant: every link below was
checked against the deployed Worker on 18 Nov 2026 and its expected verdict is in the comment at the end.)

## Essays that are still here

- [Hackers and Painters](https://www.paulgraham.com/hp.html) by Paul Graham
- [The WorldWideWeb project](http://info.cern.ch/hypertext/WWW/TheProject.html), the first website, still at CERN

## Places that are gone

- The [Open Directory Project](http://www.dmoz.org/), the hand-made index of the web
- [Freebase](http://www.freebase.com/), the open knowledge graph
- [Google Reader](http://www.google.com/reader/about/), where many of us read all of this

## Places that are not what they were

- [GeoCities SiliconValley](http://www.geocities.com/SiliconValley/), the neighbourhood for tech homepages
- [Kiko](http://www.kiko.com/), the calendar app famously sold on eBay
- [CodePlex](http://www.codeplex.com/), Microsoft's open-source host

## Doors that stay shut

- [GitHub's API](https://api.github.com/user), which asks every visitor for a token and lets nobody in without one

<!--
Expected verdicts:
alive      paulgraham.com/hp.html (200), info.cern.ch/hypertext/WWW/TheProject.html (200)
dead       dmoz.org (DNS), freebase.com (404), google.com/reader/about/ (404)
possessed  geocities.com -> yahoo.com, kiko.com -> bestshop.com, codeplex.com -> microsoft.com
           (kiko.com is occasionally restless from Cloudflare: "No answer within 8 s")
restless   api.github.com/user (401 to visitors without a token)
-->
