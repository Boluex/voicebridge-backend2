import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding VoiceBridge database...')

  // Demo user
  const passwordHash = await bcrypt.hash('password123', 12)
  const user = await prisma.user.upsert({
    where:  { email: 'demo@voicebridge.io' },
    update: {},
    create: {
      email:        'demo@voicebridge.io',
      name:         'Demo User',
      passwordHash,
    },
  })
  console.log(`✓ User: ${user.email}`)

  // Demo business
  const business = await prisma.business.upsert({
    where:  { slug: 'mamas-kitchen-demo' },
    update: {},
    create: {
      userId:         user.id,
      name:           "Mama's Kitchen",
      slug:           'mamas-kitchen-demo',
      category:       'RESTAURANT',
      description:    'Authentic Nigerian cuisine delivered to your door.',
      phone:          '+234 803 000 0001',
      email:          'hello@mamaskitchen.ng',
      address:        '14 Allen Avenue, Ikeja',
      city:           'Lagos',
      country:        'NG',
      deliveryRadius: 5,
      agentName:      'Ava',
      agentGender:    'female',
      agentVoiceId:   '21m00Tcm4TlvDq8ikWAM',
      agentGreeting:  "Hello! You've reached Mama's Kitchen. I'm Ava. How can I help you today?",
      agentTone:      'friendly',
      primaryLanguage: 'en',
      aiPhoneNumber:   '+1 555 VB DEMO',
      plan:            'PROFESSIONAL',
    },
  })
  console.log(`✓ Business: ${business.name}`)

  // Seed catalogue items
  const menuItems = [
    { name: 'Jollof Rice',        price: 3500, category: 'Main',      description: 'Classic party jollof rice with smoky flavour' },
    { name: 'Fried Rice',         price: 3500, category: 'Main',      description: 'Nigerian fried rice with mixed vegetables' },
    { name: 'Egusi Soup',         price: 2800, category: 'Soup',      description: 'Rich melon seed soup with assorted meat' },
    { name: 'Pounded Yam',        price: 800,  category: 'Swallow',   description: 'Smooth pounded yam — pair with any soup' },
    { name: 'Grilled Chicken',    price: 4500, category: 'Protein',   description: 'Whole grilled chicken marinated in spices' },
    { name: 'Fried Plantain',     price: 1200, category: 'Sides',     description: 'Sweet ripe plantain, deep fried to perfection' },
    { name: 'Pepper Soup',        price: 3000, category: 'Soup',      description: 'Spicy Nigerian pepper soup with goat meat' },
    { name: 'Suya (250g)',        price: 2500, category: 'Grills',    description: 'Grilled spiced beef skewers with onions' },
    { name: 'Zobo Drink (500ml)', price: 800,  category: 'Drinks',    description: 'Fresh hibiscus drink, chilled' },
    { name: 'Chapman',            price: 1500, category: 'Drinks',    description: 'Nigerian cocktail with Grenadine and Fanta' },
  ]

  for (const item of menuItems) {
    await prisma.catalogItem.upsert({
      where:  { id: `seed-${business.id}-${item.name.toLowerCase().replace(/\s/g, '-')}` },
      update: {},
      create: { id: `seed-${business.id}-${item.name.toLowerCase().replace(/\s/g, '-')}`, businessId: business.id, ...item },
    })
  }
  console.log(`✓ Catalogue: ${menuItems.length} items`)

  // Seed knowledge source
  await prisma.knowledgeSource.upsert({
    where:  { id: 'seed-ks-faq-1' },
    update: {},
    create: {
      id:         'seed-ks-faq-1',
      businessId: business.id,
      type:       'FAQ',
      name:       'Business FAQ',
      content: `
Q: What are your opening hours?
A: We are open 7 days a week, from 10am to 10pm.

Q: Do you offer delivery?
A: Yes! We deliver within a 5km radius of Allen Avenue, Ikeja. Delivery takes 30-45 minutes.

Q: What is the minimum order for delivery?
A: The minimum order for delivery is ₦3,000.

Q: Do you cater for events?
A: Yes, we do event catering. Please call us directly at +234 803 000 0001 for large orders.

Q: Are you halal certified?
A: Yes, all our meat is halal certified.

Q: Can I make special dietary requests?
A: Yes, please inform us of any dietary restrictions when placing your order.
      `.trim(),
      chunkCount: 6,
      status:     'INDEXED',
    },
  })

  // Seed sample calls
  const statuses = ['COMPLETED', 'ESCALATED', 'COMPLETED', 'COMPLETED', 'MISSED']
  for (let i = 0; i < 5; i++) {
    await prisma.call.create({
      data: {
        businessId:   business.id,
        callerNumber: `+234 80${Math.floor(Math.random()*9)}${Math.floor(Math.random()*9000000+1000000)}`,
        duration:     Math.floor(Math.random() * 300 + 30),
        status:       statuses[i] as any,
        intent:       ['order', 'inquiry', 'complaint'][i % 3],
        language:     'en',
        summary:      'Call handled by AI agent',
        startedAt:    new Date(Date.now() - i * 3600000),
        endedAt:      new Date(Date.now() - i * 3600000 + 120000),
      },
    })
  }
  console.log('✓ Sample calls seeded')

  console.log('\n✅ Seed complete!')
  console.log('   Login: demo@voicebridge.io / password123')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
